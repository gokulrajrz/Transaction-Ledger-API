-- Enforce descriptions for future ledger rows without changing immutable history.
-- NOT VALID retains existing NULL descriptions; PostgreSQL still checks new rows.
ALTER TABLE ledger.transactions
    ADD CONSTRAINT transactions_description_required
    CHECK (description IS NOT NULL AND description ~ '[^[:space:]]') NOT VALID;
