CREATE TABLE ledger.transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_account_id UUID NOT NULL REFERENCES ledger.accounts(id) ON DELETE RESTRICT,
    to_account_id UUID NOT NULL REFERENCES ledger.accounts(id) ON DELETE RESTRICT,
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
    reference_id TEXT NOT NULL CHECK (length(trim(reference_id)) > 0 AND length(reference_id) <= 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT transfers_distinct_accounts CHECK (from_account_id <> to_account_id),
    CONSTRAINT transfers_source_reference_unique UNIQUE (from_account_id, reference_id)
);

ALTER TABLE ledger.transactions ADD COLUMN transfer_id UUID REFERENCES ledger.transfers(id) ON DELETE RESTRICT;
ALTER TABLE ledger.transactions ADD CONSTRAINT transactions_transfer_type_unique UNIQUE (transfer_id, type);
CREATE INDEX idx_transfers_destination ON ledger.transfers (to_account_id);

CREATE TRIGGER transfers_immutable BEFORE UPDATE OR DELETE ON ledger.transfers
FOR EACH ROW EXECUTE FUNCTION ledger.reject_transaction_mutation();

REVOKE ALL ON ledger.transfers FROM PUBLIC;
