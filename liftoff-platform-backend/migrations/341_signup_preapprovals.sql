-- migrations/341_signup_preapprovals.sql
--
-- Pre-signup guest list. Migration 304 gave us email-level whitelisting via
-- accounts.access_status, but that column lives on the account row, which does
-- not exist until the person signs up — so an admin who already knows someone
-- is coming has nowhere to record it and has to wait for the notification
-- email and click Approve. This table is that missing slot: an email cleared
-- in advance, consumed by the signup that matches it.
--
-- Consumed, not deleted. The row IS the audit trail (who cleared whom, when,
-- and which account it let in), so consumption marks rather than removes.
-- That also makes the grant one-shot, which matters because account deletion
-- here is a hard DELETE that also removes the Firebase user precisely so the
-- address can re-register (AccountService.cascadeDelete step 4). Without
-- consumption a deleted-then-resigned-up user would be auto-granted forever,
-- silently, cutting across the abuse-prevention posture that
-- accounts_deletion_ledger (migration 221) exists to support.
--
-- No tenant_id and no RLS: this is platform-global operator state, exactly
-- like accounts and invite_requests, and is written only by the admin router
-- and read only by AccountService.create.

CREATE TABLE IF NOT EXISTS signup_preapprovals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored lowercase; the CHECK is the guard that a mixed-case entry can never
  -- sit in the list looking active while never matching a signup.
  email               TEXT NOT NULL CHECK (email = lower(email)),
  -- Free-text operator note ("prospect from the Acme call").
  note                TEXT,
  -- The admin who cleared them. SET NULL rather than CASCADE: a departing
  -- admin must not erase the record that the decision happened.
  added_by            UUID REFERENCES accounts(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = still on the list. Non-NULL = the signup happened and this entry
  -- has been spent.
  consumed_at         TIMESTAMPTZ,
  consumed_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL
);

-- At most one LIVE pre-approval per address. Partial, because spent entries
-- are the audit trail and must be allowed to accumulate — and because a second
-- clearing of an address that was already used is a real, separate decision.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_preapprovals_live_email
  ON signup_preapprovals (email)
  WHERE consumed_at IS NULL;
