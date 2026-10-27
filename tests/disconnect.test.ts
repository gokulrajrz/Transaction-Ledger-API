import { spawn } from 'node:child_process';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createTestDatabase, unusedPort } from './setup/database.js';

it('survives a physical database disconnect during a posting and safely retries the same reference', async () => {
  const fixture = await createTestDatabase();
  const databaseUrl = new URL(fixture.url);
  const databasePort = Number(databaseUrl.port);
  const sockets = new Set<Socket>();
  let interrupt = false;
  let interrupted = false;
  const proxy = createServer((socket) => {
    const upstream = connect({ host: '127.0.0.1', port: databasePort });
    sockets.add(socket);
    sockets.add(upstream);
    socket.on('error', () => {});
    upstream.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      socket.destroy();
    });
    let recent = '';
    socket.on('data', (chunk: Buffer) => {
      recent = (recent + chunk.toString('utf8')).slice(-8192);
      if (interrupt && recent.includes('INSERT INTO ledger.transactions')) {
        interrupt = false;
        interrupted = true;
        socket.destroy();
        upstream.destroy();
      }
    });
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  let server: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === 'string')
      throw new Error('No proxy port');
    databaseUrl.port = String(address.port);
    const port = await unusedPort();
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl.href,
        PORT: String(port),
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    server.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Server startup timed out')),
        10000,
      );
      server!.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Server listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      server!.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server!.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Server exited before listening'));
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    const created = await fetch(`${origin}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Disconnect regression' }),
      signal: AbortSignal.timeout(10000),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const post = () =>
      fetch(`${origin}/accounts/${id}/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'credit',
          amount: 50,
          reference_id: 'disconnect-retry',
        }),
        signal: AbortSignal.timeout(10000),
      });
    interrupt = true;
    expect((await post()).status).toBe(500);
    expect(interrupted).toBe(true);
    expect(server.exitCode).toBeNull();
    expect(stderr).not.toContain("Unhandled 'error' event");
    expect((await fetch(`${origin}/ready`)).status).toBe(200);
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(409);
    const balance = await fetch(`${origin}/accounts/${id}/balance`);
    expect(await balance.json()).toEqual({ account_id: id, balance: '50.00' });
    const entries = await fixture.pool.query(
      'SELECT amount FROM ledger.transactions WHERE account_id=$1',
      [id],
    );
    expect(entries.rows).toEqual([{ amount: '50.00' }]);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      const timer = setTimeout(() => server!.kill('SIGKILL'), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await fixture.stop();
  }
}, 30000);
