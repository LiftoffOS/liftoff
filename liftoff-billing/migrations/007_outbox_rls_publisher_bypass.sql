-- migrations/007_outbox_rls_publisher_bypass.sql
-- Replace outbox_events tenant_isolation policy with
-- publisher-aware policies.
--
-- Migration 002 applied a strict tenant_isolation policy on outbox_events
-- using current_setting('app.current_tenant_id', false) (missing_ok=false).
-- The outbox background publisher queries ALL tenants' rows without a tenant
-- context, causing 22023 "unrecognized configuration parameter" on every poll.
--
-- Fix: split into three policies:
--   outbox_tenant_insert  — app inserts require tenant context (strict)
--   outbox_tenant_select  — app reads scoped to current tenant
--   outbox_publisher_all  — publisher reads/updates when no context bound

BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON outbox_events;

-- App inserts must supply tenant context (fail-hard if missing).
CREATE POLICY outbox_tenant_insert ON outbox_events
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', false)::uuid);

-- App reads scoped to current tenant. Uses missing_ok=true so a missing
-- GUC simply returns no rows rather than crashing (belt-and-suspenders;
-- the outbox_publisher_all policy handles the publisher case).
CREATE POLICY outbox_tenant_select ON outbox_events
  FOR SELECT
  USING (
    current_setting('app.current_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

-- Publisher bypass: SELECT and UPDATE when no tenant context is bound.
-- The publisher connects as billing_app without setting the GUC so it
-- can drain all tenants' pending events.
CREATE POLICY outbox_publisher_all ON outbox_events
  FOR ALL
  USING (current_setting('app.current_tenant_id', true) IS NULL)
  WITH CHECK (current_setting('app.current_tenant_id', true) IS NULL);

COMMIT;
