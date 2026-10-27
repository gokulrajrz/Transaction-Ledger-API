import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createPool } from './db/pool.js';
import { checkDatabase } from './db/readiness.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const app = buildApp(pool, { logger: true });
  const shutdown = async () => {
    try {
      await app.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
  try {
    await checkDatabase(pool);
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch {
    await app.close();
    throw new Error(
      'Server startup failed; verify database connectivity, migrations, TLS, and port configuration',
    );
  }
}

main().catch((error: unknown) => {
  // Only configuration field names and our own static startup messages reach stderr.
  process.stderr.write(
    `${error instanceof Error && (error.message.startsWith('Invalid environment') || error.message.startsWith('Server startup')) ? error.message : 'Server startup failed'}\n`,
  );
  process.exitCode = 1;
});
