-- migrations/023_background_reader_rls_bypass.sql
-- Background-reader RLS split for subscriptions + payment_methods.
--
-- Migration 002's strict tenant_isolation policy uses
-- current_setting('app.current_tenant_id', false) (missing_ok=false), which
-- THROWS 42704/22023 on any connection that never bound the GUC. Cross-tenant
-- background jobs (subscription-reconciliation, card-expiring-reminders) read
-- these tables with no tenant context, so every such read crashes. A scheduler
-- that fails auth first (401) hides the crash entirely.
--
-- Same fix shape as migration 007's outbox_events split, narrowed to
-- SELECT-only for the unbound case:
--   *_tenant_write   — INSERT strict (fail-hard without tenant context)
--   *_tenant_update  — UPDATE/DELETE only with a bound, matching context
--   *_tenant_select  — tenant-scoped reads (missing_ok=true)
--   *_background_select — reads when NO context is bound (background jobs;
--                         request paths always bind via withBillingTenant)

BEGIN;

-- ── subscriptions ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS tenant_isolation ON subscriptions;

CREATE POLICY subscriptions_tenant_write ON subscriptions
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', false)::uuid);

CREATE POLICY subscriptions_tenant_update ON subscriptions
  FOR UPDATE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

CREATE POLICY subscriptions_tenant_delete ON subscriptions
  FOR DELETE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

CREATE POLICY subscriptions_tenant_select ON subscriptions
  FOR SELECT
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

CREATE POLICY subscriptions_background_select ON subscriptions
  FOR SELECT
  USING (current_setting('app.current_tenant_id', true) IS NULL);

-- ── payment_methods ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS tenant_isolation ON payment_methods;

CREATE POLICY payment_methods_tenant_write ON payment_methods
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', false)::uuid);

CREATE POLICY payment_methods_tenant_update ON payment_methods
  FOR UPDATE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

CREATE POLICY payment_methods_tenant_delete ON payment_methods
  FOR DELETE
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

CREATE POLICY payment_methods_tenant_select ON payment_methods
  FOR SELECT
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

CREATE POLICY payment_methods_background_select ON payment_methods
  FOR SELECT
  USING (current_setting('app.current_tenant_id', true) IS NULL);

COMMIT;
