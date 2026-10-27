import type { Pool } from 'pg';
import { AppError, insufficientBalance } from '../../common/errors.js';
import { inTransaction } from '../../db/transaction.js';
import { isConstraintViolation } from '../../db/types.js';
import { lockAccount, postEntry } from '../transactions/transaction.service.js';
import type { TransferInput } from './transfer.schema.js';

interface Transfer extends TransferInput {
  id: string;
  created_at: Date;
}

function duplicate(existing: Transfer): never {
  throw new AppError(
    409,
    'DUPLICATE_TRANSFER',
    'A transfer with this source and reference already exists',
    [existing],
  );
}

export async function transferMoney(pool: Pool, input: TransferInput) {
  try {
    return await inTransaction(pool, async (client) => {
      const accounts = new Map<
        string,
        Awaited<ReturnType<typeof lockAccount>>
      >();
      // UUIDs have already been normalized to lower case by validation.
      for (const id of [input.from_account_id, input.to_account_id].sort()) {
        accounts.set(id, await lockAccount(client, id, input.amount));
      }
      const existing = await client.query<Transfer>(
        'SELECT * FROM ledger.transfers WHERE from_account_id=$1 AND reference_id=$2',
        [input.from_account_id, input.reference_id],
      );
      if (existing.rows[0]) duplicate(existing.rows[0]);
      if (!accounts.get(input.from_account_id)!.sufficient)
        insufficientBalance();
      const created = await client.query<Transfer>(
        'INSERT INTO ledger.transfers (from_account_id,to_account_id,amount,reference_id) VALUES ($1,$2,$3,$4) RETURNING *',
        [
          input.from_account_id,
          input.to_account_id,
          input.amount,
          input.reference_id,
        ],
      );
      const transfer = created.rows[0]!;
      const debit = await postEntry(
        client,
        input.from_account_id,
        {
          type: 'debit',
          amount: input.amount,
          reference_id: `transfer/${transfer.id}/debit`,
        },
        transfer.id,
      );
      const credit = await postEntry(
        client,
        input.to_account_id,
        {
          type: 'credit',
          amount: input.amount,
          reference_id: `transfer/${transfer.id}/credit`,
        },
        transfer.id,
      );
      return { ...transfer, transactions: [debit, credit] };
    });
  } catch (error) {
    if (isConstraintViolation(error, 'transfers_source_reference_unique')) {
      const existing = await pool.query<Transfer>(
        'SELECT * FROM ledger.transfers WHERE from_account_id=$1 AND reference_id=$2',
        [input.from_account_id, input.reference_id],
      );
      if (existing.rows[0]) duplicate(existing.rows[0]);
    }
    throw error;
  }
}
