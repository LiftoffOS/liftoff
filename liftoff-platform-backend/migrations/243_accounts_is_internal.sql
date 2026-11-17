-- Adds accounts.is_internal so the frontend can mark Liftoff staff as
-- $internal_or_test_user in PostHog and keep them out of product analytics.
--
-- Auto-derived on writes (account creation + email-change confirmation) from
-- the configured INTERNAL_EMAIL_DOMAINS list in code, but stored — not
-- computed — so it can be overridden manually for edge cases (contractors on
-- personal email, non-domain staff, etc.) via a one-row UPDATE.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: flag every existing @example.com email as internal.
UPDATE accounts
   SET is_internal = TRUE
 WHERE LOWER(email) LIKE '%@example.com';
