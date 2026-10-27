import type { Pool } from 'pg';
import { accountNotFound } from '../../common/errors.js';
import type { Account } from '../../db/types.js';

export async function createAccount(pool: Pool, name: string) {
  const result = await pool.query<Account>(
    'INSERT INTO ledger.accounts (name) VALUES ($1) RETURNING *',
    [name],
  );
  return result.rows[0]!;
}

export async function getBalance(pool: Pool, id: string) {
  const result = await pool.query<{ account_id: string; balance: string }>(
    'SELECT id AS account_id, balance FROM ledger.accounts WHERE id = $1',
    [id],
  );
  if (!result.rowCount) accountNotFound();
  return result.rows[0]!;
}
