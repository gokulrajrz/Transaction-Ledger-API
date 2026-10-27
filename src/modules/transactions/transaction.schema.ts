import { z } from 'zod';
import {
  amount,
  databaseText,
  referenceId,
  transactionType,
} from '../../common/validation.js';

export const createTransactionSchema = z.strictObject({
  type: transactionType,
  amount,
  description: databaseText.max(2000).optional(),
  reference_id: referenceId.refine(
    (value) => !value.startsWith('transfer/'),
    'The transfer/ reference prefix is reserved',
  ),
});
export type TransactionInput = z.infer<typeof createTransactionSchema>;

const integerQuery = (fallback: string, max: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));
export const historySchema = z.strictObject({
  type: transactionType.optional(),
  page: integerQuery('1', 2_147_483_647),
  limit: integerQuery('20', 100),
});
export type HistoryQuery = z.infer<typeof historySchema>;
