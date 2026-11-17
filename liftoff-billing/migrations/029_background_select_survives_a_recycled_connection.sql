-- The background-read lanes on subscriptions and payment_methods close on any
-- pooled connection that has previously served a tenant.
--
-- Migration 023 opened those lanes for the two jobs that genuinely read across
-- tenants — subscription-reconciliation and card-expiring-reminders, both of
-- which query `deps.pool` directly with no tenant bound. It tested for an
-- absent GUC with `current_setting('app.current_tenant_id', true) IS NULL`.
--
-- That is only true on a connection which has NEVER been scoped. Releasing a
-- tenant scope RESETs the GUC, and PostgreSQL's RESET on a custom GUC with no
-- server-level default leaves it as the EMPTY STRING, not NULL. Connections are
-- pooled, so from the first tenant-scoped request onward every connection in the
-- pool carries '' for the rest of its life. On such a connection:
--
--   *_background_select:  '' IS NULL     -> false, the lane closes
--   *_tenant_select:      '' IS NOT NULL -> true, then ''::uuid raises 22P02
--
-- So both jobs fail with "invalid input syntax for type uuid" whenever they draw
-- a recycled connection, which is almost always. This repo has met this bug
-- twice before — migrations 011/012 on outbox_events, migration 027 on
-- referral_credits — and 023 was written between them in the older shape.
--
-- The form below is migration 012's, which is the one that holds: `coalesce(GUC,
-- '') = ''` treats unset and empty as the same thing, and CASE guarantees
-- evaluation order so the ::uuid cast is never reached when there is nothing to
-- cast. An AND-guard does not, which is precisely why migration 011 was not
-- enough on its own.
--
-- SELECT ONLY. The INSERT/UPDATE/DELETE policies from 023 are left exactly as
-- they are: a write must always carry a tenant, and an unscoped one should keep
-- failing loudly rather than being quietly denied.
--
-- The five tables still on migration 002's strict policy — invoices,
-- meter_events, payment_method_audit, credit_balances, billing_audit_log — are
-- deliberately untouched. Nothing reads them across tenants, so strict is
-- correct, and opening a lane nothing needs would let any connection that forgot
-- to scope itself read every tenant's invoices and payment methods.

BEGIN;

-- ── subscriptions ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS subscriptions_tenant_select ON subscriptions;
CREATE POLICY subscriptions_tenant_select ON subscriptions
  FOR SELECT
  USING (
    CASE
      WHEN coalesce(current_setting('app.current_tenant_id', true), '') = '' THEN FALSE
      ELSE tenant_id = current_setting('app.current_tenant_id', true)::uuid
    END
  );

DROP POLICY IF EXISTS subscriptions_background_select ON subscriptions;
CREATE POLICY subscriptions_background_select ON subscriptions
  FOR SELECT
  USING (coalesce(current_setting('app.current_tenant_id', true), '') = '');

-- ── payment_methods ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS payment_methods_tenant_select ON payment_methods;
CREATE POLICY payment_methods_tenant_select ON payment_methods
  FOR SELECT
  USING (
    CASE
      WHEN coalesce(current_setting('app.current_tenant_id', true), '') = '' THEN FALSE
      ELSE tenant_id = current_setting('app.current_tenant_id', true)::uuid
    END
  );

DROP POLICY IF EXISTS payment_methods_background_select ON payment_methods;
CREATE POLICY payment_methods_background_select ON payment_methods
  FOR SELECT
  USING (coalesce(current_setting('app.current_tenant_id', true), '') = '');

COMMENT ON TABLE subscriptions IS
  'Stripe subscription mirror. Cross-tenant background jobs (subscription-reconciliation, card-expiring-reminders) read it with NO tenant bound; the SELECT policies treat an unset OR empty app.current_tenant_id as unbound, because a pooled connection carries the empty string once its first tenant scope has been released.';
COMMENT ON TABLE payment_methods IS
  'Local mirror of Stripe payment methods, read by lookupDefaultPaymentMethod and by the card-expiring sweep. Same unbound-means-unset-or-empty rule as subscriptions.';

COMMIT;
