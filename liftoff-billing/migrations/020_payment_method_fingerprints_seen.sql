-- 020_payment_method_fingerprints_seen.sql
--
-- Per-fingerprint history table for promo-abuse detection. A Stripe
-- payment method's fingerprint is the same for any tokenization of the
-- same underlying card. We mark fingerprints whose customer has been
-- soft-deleted; the eligibility helper (Phase 7) blocks promo redemption
-- when a new signup attempts to use a fingerprint last seen on a
-- deleted customer.
--
-- Webhook side-effect: payment_method.attached UPSERTs (active). The
-- soft-scrub endpoint flips status to 'deleted'.
--
-- NO ROW-LEVEL SECURITY. Unlike billing's tenant-scoped tables (RLS
-- enforced via app.current_tenant_id GUC, see migrations/002_rls.sql),
-- this table is not tenant-scoped — it's customer-scoped and accessed
-- only by internal callers:
--   * The Stripe webhook handler (no user context, no tenant_id available)
--   * The soft-scrub endpoint (HMAC-signed from platform-backend)
--   * The promo-eligibility helper (Phase 7, internal billing logic)
-- Enabling RLS would require setting current_tenant_id on every internal
-- caller and would surface no actual security benefit (the table has no
-- customer-facing read path).

CREATE TABLE payment_method_fingerprints_seen (
  fingerprint        TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  customer_status    TEXT NOT NULL CHECK (customer_status IN ('active','deleted')),
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (fingerprint, stripe_customer_id)
);

CREATE INDEX idx_pm_fingerprints_status
  ON payment_method_fingerprints_seen (fingerprint, customer_status);

-- Explicitly NOT enabling RLS — internal table only.
-- ALTER TABLE payment_method_fingerprints_seen ENABLE ROW LEVEL SECURITY;  -- DO NOT ADD
