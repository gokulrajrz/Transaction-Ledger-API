import type { Pool } from 'pg';

export async function checkDatabase(pool: Pool): Promise<void> {
  // Resolves tables, migration-dependent columns and read privileges without
  // scanning ledger data. Startup and readiness must use the same check.
  await pool.query(`SELECT a.id, t.transfer_id, f.id
    FROM ledger.accounts a, ledger.transactions t, ledger.transfers f LIMIT 0`);
  // Check schema safeguards rather than provider-specific migration bookkeeping.
  const result = await pool.query<{ intact: boolean }>(`
    SELECT NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('accounts', 'accounts_balance_check'),
        ('transactions', 'transactions_amount_check'),
        ('transactions', 'transactions_type_check'),
        ('transactions', 'transactions_description_required'),
        ('transactions', 'transactions_account_reference_unique'),
        ('transactions', 'transactions_transfer_type_unique'),
        ('transfers', 'transfers_source_reference_unique'),
        ('transfers', 'transfers_distinct_accounts')
      ) AS required(table_name, constraint_name)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'ledger' AND t.relname = required.table_name
          AND c.conname = required.constraint_name
          -- A legacy NOT VALID description check still enforces every new row.
          AND (c.convalidated OR (required.table_name = 'transactions'
            AND required.constraint_name = 'transactions_description_required'))
      )
    ) AND NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('transactions', 'transactions_immutable'),
        ('transfers', 'transfers_immutable')
      ) AS required(table_name, trigger_name)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger g
        JOIN pg_catalog.pg_class t ON t.oid = g.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'ledger' AND t.relname = required.table_name
          AND g.tgname = required.trigger_name AND g.tgenabled IN ('O', 'A')
      )
    ) AS intact`);
  if (!result.rows[0]?.intact)
    throw new Error('Ledger integrity safeguards are missing');
}
