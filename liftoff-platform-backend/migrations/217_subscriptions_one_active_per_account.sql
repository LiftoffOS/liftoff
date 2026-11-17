-- Migration 217 — partial unique index enforcing one active subscription per
-- account.
--
-- Closes the duplicate-subscription class of bug (repeated provisioning
-- attempts can leave an account with multiple active Stripe subs — the local
-- mirror only ever stores one, but nothing prevented re-insert at the schema
-- layer).
--
-- ADR-012 calls this "subscriptions_one_active_per_tenant"; the local
-- subscriptions table is account-scoped (one row per account, not per
-- tenant), so the index goes on account_id. The "active-ish" status set
-- matches the Stripe states where billing is live or will become live:
--   active, trialing, past_due, incomplete.
-- Canceled/incomplete_expired/unpaid rows are not active billing relationships
-- and are excluded so the row stays in the history for audit.
--
-- If a duplicate ever appears at deploy time the CREATE will fail — that's
-- the desired behavior, the operator must collapse the duplicates before
-- the index can land.

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_account
  ON subscriptions (account_id)
  WHERE status IN ('active', 'trialing', 'past_due', 'incomplete');
