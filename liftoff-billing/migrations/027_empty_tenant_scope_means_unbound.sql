-- An empty app.current_tenant_id must mean "no tenant bound", the same as unset.
--
-- Postgres cannot return a custom GUC to NULL once it has been set. Verified on
-- the live database: after set_config('app.current_tenant_id', <uuid>, true) and
-- then set_config('app.current_tenant_id', NULL, true), current_setting(...,
-- true) is the EMPTY STRING, not NULL. Connections are pooled, so any connection
-- that has ever served a tenant-scoped request carries '' from then on.
--
-- Migration 025 wrote these policies against NULL, which is only ever true on a
-- connection that has never been scoped. On a recycled one:
--
--   background_select:  '' IS NULL      -> false, the cross-tenant lane closes
--   tenant_select:      '' IS NOT NULL  -> true, then ''::uuid raises 22P02
--
-- So the cross-tenant sweeps (vesting, expiry, reversal, disqualification) fail
-- on a recycled connection with "invalid input syntax for type uuid" — the exact
-- error that took the referral summary down, from the exact same cause.
--
-- NULLIF collapses '' and unset into one meaning. The write policies are left
-- strict on purpose: a write must always be scoped, and an unscoped one should
-- keep failing loudly rather than being quietly denied.

BEGIN;

DROP POLICY IF EXISTS referral_credits_tenant_select ON referral_credits;
CREATE POLICY referral_credits_tenant_select ON referral_credits
  FOR SELECT
  USING (
    NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL
    AND tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
  );

DROP POLICY IF EXISTS referral_credits_background_select ON referral_credits;
CREATE POLICY referral_credits_background_select ON referral_credits
  FOR SELECT
  USING (NULLIF(current_setting('app.current_tenant_id', true), '') IS NULL);

COMMENT ON TABLE referral_credits IS
  'One grant per earning referral, held by the REFERRER. Per-grant expiry because the timer ages each one separately; spent nearest-expiry-first. No negative balance and no clawback: spent credit that is reversed is absorbed. Cross-tenant sweeps read it with app.current_tenant_id set to the empty string, which the SELECT policies treat as unbound.';

COMMIT;
