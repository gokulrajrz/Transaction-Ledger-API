import type { Pool } from 'pg';

export async function checkDatabase(pool: Pool): Promise<void> {
  // Resolves tables, migration-dependent columns and read privileges without
  // scanning ledger data. Startup and readiness must use the same check.
  await pool.query(`SELECT a.id, t.transfer_id, f.id
    FROM ledger.accounts a, ledger.transactions t, ledger.transfers f LIMIT 0`);
}
