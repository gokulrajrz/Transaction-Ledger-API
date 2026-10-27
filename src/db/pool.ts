import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { Config } from '../config/env.js';

export function createPool(config: Config): pg.Pool {
  const host = new URL(config.DATABASE_URL).hostname;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    lock_timeout: config.DB_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    application_name: 'confluencr-ledger-api',
    ssl:
      local && !config.DB_SSL_CA_FILE
        ? false
        : {
            rejectUnauthorized: true,
            ...(config.DB_SSL_CA_FILE
              ? { ca: readFileSync(config.DB_SSL_CA_FILE, 'utf8') }
              : {}),
          },
  });
  // An idle backend failure must not become an uncaught EventEmitter error.
  pool.on('error', () => {
    process.stderr.write(
      'Idle database connection failed; connection discarded\n',
    );
  });
  return pool;
}
