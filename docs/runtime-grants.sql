-- Run as migration owner after creating a LOGIN role named ledger_runtime via
-- your database administration workflow. Do not use the migration owner at runtime.
-- This script intentionally does not create a password or grant table ownership.
GRANT USAGE ON SCHEMA ledger TO ledger_runtime;
GRANT SELECT ON ledger.accounts, ledger.transactions, ledger.transfers TO ledger_runtime;
GRANT INSERT (name) ON ledger.accounts TO ledger_runtime;
GRANT UPDATE (balance) ON ledger.accounts TO ledger_runtime;
GRANT INSERT (account_id, type, amount, description, reference_id, transfer_id)
    ON ledger.transactions TO ledger_runtime;
GRANT INSERT (from_account_id, to_account_id, amount, reference_id)
    ON ledger.transfers TO ledger_runtime;
