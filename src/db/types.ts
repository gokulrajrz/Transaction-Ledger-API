export interface Account {
  id: string;
  name: string;
  balance: string;
  created_at: Date;
}

export interface LedgerTransaction {
  id: string;
  account_id: string;
  type: 'credit' | 'debit';
  amount: string;
  description: string | null;
  reference_id: string;
  created_at: Date;
  transfer_id: string | null;
}

export function isConstraintViolation(
  error: unknown,
  constraint: string,
): boolean {
  if (!(error instanceof Error)) return false;
  const info = error as { code?: string; constraint?: string };
  return info.code === '23505' && info.constraint === constraint;
}
