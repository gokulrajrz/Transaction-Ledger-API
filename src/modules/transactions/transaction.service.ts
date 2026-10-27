import type { Pool, PoolClient } from 'pg';
import {
  accountNotFound,
  AppError,
  insufficientBalance,
} from '../../common/errors.js';
import { inTransaction } from '../../db/transaction.js';
import type { HistoryQuery, TransactionInput } from './transaction.schema.js';
import {
  isConstraintViolation,
  type LedgerTransaction,
} from '../../db/types.js';

export async function lockAccount(
  client: PoolClient,
  id: string,
  amount: string,
) {
  const result = await client.query<{ id: string; sufficient: boolean }>(
    'SELECT id, balance >= $2::numeric AS sufficient FROM ledger.accounts WHERE id = $1 FOR UPDATE',
    [id, amount],
  );
  const account = result.rows[0];
  if (!account) accountNotFound();
  return account;
}

export async function postEntry(
  client: PoolClient,
  accountId: string,
  input: TransactionInput,
  transferId: string | null = null,
) {
  const result = await client.query<LedgerTransaction>(
    `INSERT INTO ledger.transactions (account_id, type, amount, description, reference_id, transfer_id)
     VALUES ($1, $2, $3::numeric, $4, $5, $6) RETURNING *`,
    [
      accountId,
      input.type,
      input.amount,
      input.description ?? null,
      input.reference_id,
      transferId,
    ],
  );
  await client.query(
    `UPDATE ledger.accounts SET balance = balance + CASE WHEN $2 = 'credit' THEN $3::numeric ELSE -$3::numeric END WHERE id = $1`,
    [accountId, input.type, input.amount],
  );
  return result.rows[0]!;
}

function duplicate(existing: LedgerTransaction): never {
  throw new AppError(
    409,
    'DUPLICATE_TRANSACTION',
    'A transaction with this reference already exists',
    [existing],
  );
}

export async function addTransaction(
  pool: Pool,
  accountId: string,
  input: TransactionInput,
) {
  try {
    return await inTransaction(pool, async (client) => {
      const account = await lockAccount(client, accountId, input.amount);
      const existing = await client.query<LedgerTransaction>(
        'SELECT * FROM ledger.transactions WHERE account_id = $1 AND reference_id = $2',
        [accountId, input.reference_id],
      );
      if (existing.rowCount) {
        duplicate(existing.rows[0]!);
      }
      if (input.type === 'debit' && !account.sufficient) insufficientBalance();
      return postEntry(client, accountId, input);
    });
  } catch (error) {
    // The account lock serializes API callers. The unique constraint is still the
    // final defense if a privileged writer bypasses that locking protocol.
    if (isConstraintViolation(error, 'transactions_account_reference_unique')) {
      const existing = await pool.query<LedgerTransaction>(
        'SELECT * FROM ledger.transactions WHERE account_id=$1 AND reference_id=$2',
        [accountId, input.reference_id],
      );
      if (existing.rows[0]) duplicate(existing.rows[0]);
    }
    throw error;
  }
}

export async function getHistory(
  pool: Pool,
  accountId: string,
  query: HistoryQuery,
) {
  const account = await pool.query(
    'SELECT 1 FROM ledger.accounts WHERE id = $1',
    [accountId],
  );
  if (!account.rowCount) accountNotFound();
  const filter = 'account_id = $1 AND ($2::text IS NULL OR type = $2)';
  const values = [accountId, query.type ?? null];
  const count = await pool.query<{ total: string }>(
    `SELECT count(*) AS total FROM ledger.transactions WHERE ${filter}`,
    values,
  );
  const result = await pool.query<LedgerTransaction>(
    `SELECT * FROM ledger.transactions WHERE ${filter} ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
    [...values, query.limit, (query.page - 1) * query.limit],
  );
  const total = Number(count.rows[0]!.total);
  return {
    data: result.rows,
    pagination: {
      page: query.page,
      limit: query.limit,
      total_records: total,
      total_pages: Math.ceil(total / query.limit),
    },
  };
}
