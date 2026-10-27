import { spawn } from 'node:child_process';
import { buildApp } from '../src/app.js';

async function runDemo() {
  // Import only in the worker: the PostgreSQL helper installs process exit hooks.
  const { createTestDatabase } = await import('../tests/setup/database.js');
  // Explicit disposable mode; does not read .env or touch DATABASE_URL.
  if (process.env.TEST_DATABASE_URL)
    throw new Error('dev:local requires TEST_DATABASE_URL to be unset');
  const fixture = await createTestDatabase();
  const app = buildApp(fixture.pool, { closePool: false });
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await app.close();
    await fixture.stop();
    process.stdout.write(
      'Disposable demo shut down; temporary database removed\n',
    );
    if (process.connected) process.disconnect();
  }
  const stop = () => {
    void shutdown().catch(() => {
      process.stderr.write('Disposable demo cleanup failed\n');
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  };
  process.on('message', (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'stop'
    )
      stop();
  });
  process.once('disconnect', stop);
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 3000 });
    process.stdout.write(
      `Disposable PostgreSQL demo listening at ${address}; data is removed on shutdown\n`,
    );
  } catch (error) {
    await shutdown();
    throw error;
  }
}

if (process.argv.includes('--worker')) {
  await runDemo();
} else {
  // Terminal Ctrl+C reaches the foreground process group. A detached worker
  // keeps PostgreSQL out of that group until API/database cleanup completes.
  const worker = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/local.ts', '--worker'],
    {
      detached: true,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    },
  );
  process.once('SIGINT', () => {
    if (worker.connected) worker.send({ type: 'stop' });
  });
  process.once('SIGTERM', () => {
    if (worker.connected) worker.send({ type: 'stop' });
  });
  worker.once('error', () => {
    process.stderr.write('Disposable demo worker could not start\n');
    process.exitCode = 1;
  });
  worker.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
