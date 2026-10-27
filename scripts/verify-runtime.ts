import { spawn } from 'node:child_process';
import { createTestDatabase, unusedPort } from '../tests/setup/database.js';

async function verify(mode: 'production' | 'development') {
  const fixture = await createTestDatabase();
  const port = await unusedPort();
  const grouped = mode === 'development' && process.platform !== 'win32';
  const server = spawn(
    mode === 'production' ? process.execPath : 'npm',
    mode === 'production' ? ['dist/server.js'] : ['run', 'dev'],
    {
      detached: grouped,
      env: {
        ...process.env,
        DATABASE_URL: fixture.url,
        PORT: String(port),
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    const address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Server did not start within 10 seconds')),
        10000,
      );
      server.stdout.on('data', (chunk: Buffer) => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
      server.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited early (${code})`));
      });
    });
    for (const path of ['/health', '/ready']) {
      if ((await fetch(`${address}${path}`)).status !== 200)
        throw new Error(`${path} failed`);
    }
    const response = await fetch(`${address}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Production build smoke' }),
    });
    const account = (await response.json()) as { id: string; balance: string };
    if (response.status !== 201 || account.balance !== '0.00')
      throw new Error('Production account creation failed');
    const posting = await fetch(
      `${address}/accounts/${account.id}/transactions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'credit',
          amount: '100',
          reference_id: 'production-smoke',
        }),
      },
    );
    if (posting.status !== 201) throw new Error('Production credit failed');
    process.stdout.write(
      `${mode} server, health/readiness, real HTTP account and posting passed\n`,
    );
  } finally {
    if (server.exitCode === null) {
      const exited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          server.kill('SIGKILL');
          reject(new Error('Graceful shutdown timed out'));
        }, 10000);
        server.once('close', (code, signal) => {
          clearTimeout(timer);
          if (code === 0 || (mode === 'development' && signal === 'SIGTERM'))
            resolve();
          else reject(new Error(`Shutdown exited ${code}`));
        });
      });
      if (grouped && server.pid) process.kill(-server.pid, 'SIGTERM');
      else server.kill('SIGTERM');
      try {
        await exited;
      } finally {
        await fixture.stop();
      }
      process.stdout.write(
        'SIGTERM graceful shutdown and disposable database cleanup passed\n',
      );
    } else {
      await fixture.stop();
    }
  }
}

await verify('production');
// POSIX process groups let the development watcher and its child shut down together.
if (process.platform !== 'win32') await verify('development');
