import { z } from 'zod';
import { AppError } from './errors.js';

export function validate<T extends z.ZodType>(
  schema: T,
  input: unknown,
  code = 'VALIDATION_ERROR',
): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(
      400,
      code,
      'Invalid request data',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export const accountParams = z.strictObject({
  id: z.uuid().transform((id) => id.toLowerCase()),
});
const decimalAmount = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/,
    'Expected a decimal string with up to 16 integer digits and 2 decimal places',
  )
  .refine((value) => /[1-9]/.test(value), 'Amount must be greater than zero');

export const amount = z
  .union([z.string(), z.number().finite().max(Number.MAX_SAFE_INTEGER)])
  // Validate the number's decimal representation before padding, never round money.
  .transform((value) => (typeof value === 'number' ? String(value) : value))
  .pipe(decimalAmount)
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  });
export const databaseText = z
  .string()
  .refine((value) => value.isWellFormed(), 'Text must contain valid Unicode')
  .refine(
    (value) => !value.includes('\u0000'),
    'Text must not contain NUL characters',
  );
export const referenceId = databaseText
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0, 'Reference must not be blank');
export const transactionType = z.enum(['credit', 'debit']);
