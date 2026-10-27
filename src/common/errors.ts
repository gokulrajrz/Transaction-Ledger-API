export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown[] = [],
  ) {
    super(message);
  }
}

export function accountNotFound(): never {
  throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
}

export function insufficientBalance(): never {
  throw new AppError(
    422,
    'INSUFFICIENT_BALANCE',
    'Insufficient balance for this debit',
  );
}
