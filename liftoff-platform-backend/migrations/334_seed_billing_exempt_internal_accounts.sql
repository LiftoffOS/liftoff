-- 334: connect `accounts.is_internal` to the charge boundary.
--
-- Migration 243 added `accounts.is_internal`, auto-derived on write from
-- INTERNAL_EMAIL_DOMAINS (accounts/internal-domains.ts). On its own it feeds
-- only an analytics marker; billing does not read it. Without a link to the
-- charge boundary, an internal account whose spend crossed a charge threshold
-- would be invoiced like any other.
--
-- Migration 333 added `billing_controls.billing_exempt`, the explicit
-- never-charged flag the charge boundary reads. This seeds it from the signal
-- that already answers the same question, rather than leaving it to a manual
-- one-row UPDATE per environment that nobody remembers to run and nothing
-- verifies. Internal accounts are, by definition, never invoiced.
--
-- Idempotent and re-runnable: `AND NOT billing_exempt` means a re-run touches
-- nothing, and it never CLEARS the flag — an account flagged by hand (a
-- contractor, a design partner, a staff member on a personal address) keeps
-- its exemption even though `is_internal` is false for it. `is_internal`
-- seeds this column; it does not own it.
--
-- What this does NOT do, deliberately: nothing here changes admission,
-- metering, OU bucket drains, spend counters or dashboards. An exempt account
-- consumes, drains and reports exactly like a paying one. The only difference
-- is that no Stripe charge and no meter event is ever produced — see
-- migration 333 and docs/billing-meter.md.

UPDATE billing_controls bc
   SET billing_exempt = TRUE,
       updated_at     = NOW()
  FROM accounts a
 WHERE a.id = bc.account_id
   AND a.is_internal
   AND NOT bc.billing_exempt;

-- Rows created AFTER this migration are covered in code, not by a future
-- backfill: all three writers that can create a billing_controls row
-- (spend-subscriber's ensureBillingControlsRow, the billing-init webhook, the
-- admin enterprise-provision route) seed billing_exempt from
-- accounts.is_internal on INSERT, and none of them touch it on conflict.
-- `src/billing/__tests__/billing-controls-insert-sites.test.ts` fails the build
-- if a fourth writer appears without that column.
