import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createTestDatabase } from '../tests/setup/database.js';

const fixture = await createTestDatabase({ migrate: false });
const cliUrl = new URL(fixture.url);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(cliUrl.hostname);
// Plaintext is limited to our disposable loopback database. Remote CLI
// connections retain full certificate and hostname verification.
cliUrl.searchParams.set('sslmode', local ? 'disable' : 'verify-full');
if (!local && process.env.DB_SSL_CA_FILE)
  cliUrl.searchParams.set('sslrootcert', process.env.DB_SSL_CA_FILE);
try {
  for (const dryRun of [true, false]) {
    // The only target is the randomly named database just created by this process.
    const args = [
      'db',
      'push',
      '--db-url',
      cliUrl.href,
      '--yes',
      ...(dryRun ? ['--dry-run'] : []),
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn('node_modules/.bin/supabase', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `Supabase migration verification failed (exit ${code}); ${output.replaceAll(cliUrl.href, '[redacted]').replaceAll(fixture.url, '[redacted]')}`,
            ),
          );
      });
    });
    process.stdout.write(
      `Supabase CLI ${dryRun ? 'migration dry run' : 'migration application'} passed on disposable database\n`,
    );
  }
  const applied = await fixture.pool.query(
    'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
  );
  const expectedVersions = (await readdir('supabase/migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => file.split('_')[0]);
  assert.deepEqual(
    applied.rows.map((row) => row.version),
    expectedVersions,
    'Recorded Supabase migrations must match the versioned SQL files',
  );
  await fixture.pool.query(
    'SELECT id, transfer_id FROM ledger.transactions LIMIT 0',
  );
  process.stdout.write(
    `${expectedVersions.length} Supabase migration versions recorded; ledger schema accessible\n`,
  );
} finally {
  await fixture.stop();
}
