-- 221_accounts_deletion_ledger.sql
--
-- Tombstone for deleted accounts. Stores irreversible hashes of contact
-- identifiers so the abuse-prevention layer (Phase 7) can refuse promo
-- redemption for re-signups of previously-deleted users without storing
-- plaintext PII past deletion.
--
-- No FK to accounts(id): the account row is gone by the time this row
-- exists. No RLS: internal table, written only by the soft-scrub branch
-- of AccountService.cascadeDelete, read only by the deletion-history
-- check endpoint.

CREATE TABLE accounts_deletion_ledger (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_sha256       TEXT NOT NULL,
  phone_sha256       TEXT,
  stripe_customer_id TEXT NOT NULL,
  deleted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_deletion_ledger_email
  ON accounts_deletion_ledger (email_sha256);

CREATE INDEX idx_accounts_deletion_ledger_phone
  ON accounts_deletion_ledger (phone_sha256)
  WHERE phone_sha256 IS NOT NULL;

CREATE INDEX idx_accounts_deletion_ledger_customer
  ON accounts_deletion_ledger (stripe_customer_id);
