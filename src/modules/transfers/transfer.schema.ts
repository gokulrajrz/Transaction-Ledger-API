import { z } from 'zod';
import { amount, referenceId } from '../../common/validation.js';

const uuid = z.uuid().transform((id) => id.toLowerCase());
export const transferSchema = z
  .strictObject({
    from_account_id: uuid,
    to_account_id: uuid,
    amount,
    reference_id: referenceId,
  })
  .refine(
    (input) => input.from_account_id !== input.to_account_id,
    'Source and destination must differ',
  );
export type TransferInput = z.infer<typeof transferSchema>;
