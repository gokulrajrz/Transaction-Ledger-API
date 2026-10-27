-- Run once through Supabase migrations. Deliberately fail on an existing ledger schema.
CREATE SCHEMA ledger;
REVOKE ALL ON SCHEMA ledger FROM PUBLIC;

CREATE TABLE ledger.accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CONSTRAINT accounts_name_check CHECK (length(trim(name)) BETWEEN 1 AND 200),
    balance NUMERIC(18,2) NOT NULL DEFAULT 0
        CONSTRAINT accounts_balance_check CHECK (balance >= 0 AND balance <> 'NaN'::numeric),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE ledger.transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES ledger.accounts(id) ON DELETE RESTRICT,
    type TEXT NOT NULL CONSTRAINT transactions_type_check CHECK (type IN ('credit', 'debit')),
    amount NUMERIC(18,2) NOT NULL CONSTRAINT transactions_amount_check CHECK (amount > 0 AND amount <> 'NaN'::numeric),
    description TEXT CONSTRAINT transactions_description_check CHECK (length(description) <= 2000),
    reference_id TEXT NOT NULL CONSTRAINT transactions_reference_check CHECK (length(trim(reference_id)) > 0 AND length(reference_id) <= 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT transactions_account_reference_unique UNIQUE (account_id, reference_id)
);

CREATE INDEX idx_transactions_account_history ON ledger.transactions (account_id, created_at DESC, id DESC);

CREATE FUNCTION ledger.reject_transaction_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Ledger transactions are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER transactions_immutable BEFORE UPDATE OR DELETE ON ledger.transactions
FOR EACH ROW EXECUTE FUNCTION ledger.reject_transaction_mutation();

REVOKE ALL ON ALL TABLES IN SCHEMA ledger FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ledger FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger REVOKE ALL ON FUNCTIONS FROM PUBLIC;
