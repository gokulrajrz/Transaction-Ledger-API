import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import { loadConfig } from '../../src/config/env.js';
import { createPool } from '../../src/db/pool.js';

export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No test port allocated');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export async function createTestDatabase(options: { migrate?: boolean } = {}) {
  let embedded: EmbeddedPostgres | undefined;
  let directory: string | undefined;
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (
    adminUrl &&
    process.env.LEDGER_EXTERNAL_TESTS !== 'allow-create-disposable-database'
  ) {
    throw new Error(
      'External test database refused: explicitly authorize creation of a disposable database with LEDGER_EXTERNAL_TESTS',
    );
  }
  if (!adminUrl) {
    directory = await mkdtemp(join(tmpdir(), 'confluencr-pg-'));
    const port = await unusedPort();
    const password = randomUUID();
    embedded = new EmbeddedPostgres({
      databaseDir: join(directory, 'data'),
      user: 'postgres',
      password,
      port,
      persistent: true,
      createPostgresUser: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-h', '127.0.0.1', '-k', directory],
      onLog: () => {},
      onError: () => {},
    });
    // The packaged initdb helper writes a temporary password file. Ensure it is private.
    const previousUmask = process.umask(0o077);
    try {
      await embedded.initialise();
    } finally {
      process.umask(previousUmask);
    }
    await embedded.start();
    adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
  }

  const admin = createPool(
    loadConfig({
      DATABASE_URL: adminUrl,
      DB_SSL_CA_FILE: process.env.DB_SSL_CA_FILE,
      NODE_ENV: 'test',
    }),
  );
  const name = `ledger_test_${randomUUID().replaceAll('-', '')}`;
  const marker = `confluencr disposable test ${randomUUID()}`;
  const identity = await admin.query<{ role: string }>(
    'SELECT current_user AS role',
  );
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${marker}'`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = createPool(
    loadConfig({
      DATABASE_URL: url.href,
      DB_SSL_CA_FILE: process.env.DB_SSL_CA_FILE,
      NODE_ENV: 'test',
      DB_POOL_MAX: 12,
    }),
  );
  const stop = async () => {
    await pool.end();
    const check = await admin.query<{
      name: string;
      owner: string;
      marker: string;
    }>(
      `SELECT datname AS name, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker
       FROM pg_database WHERE datname = $1`,
      [name],
    );
    const db = check.rows[0];
    if (
      !/^ledger_test_[a-f0-9]{32}$/.test(name) ||
      db?.owner !== identity.rows[0]?.role ||
      db?.marker !== marker
    ) {
      throw new Error(
        'Refused test cleanup: disposable database identity did not match',
      );
    }
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
    if (embedded) await embedded.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  };
  try {
    const files = (await readdir('supabase/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of options.migrate === false ? [] : files) {
      const sql = await readFile(join('supabase/migrations', file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { pool, admin, url: url.href, name, stop };
}
