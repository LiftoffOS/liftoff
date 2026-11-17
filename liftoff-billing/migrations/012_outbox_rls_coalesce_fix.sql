-- Migration 012: Fix outbox RLS for RESET-induced empty-string GUC
--
-- Root cause: withTenantScope (packages/database) runs RESET on the GUC in its
-- finally block. PostgreSQL's RESET on a custom GUC (no server-level default)
-- sets it to '' (empty string), NOT NULL. The outbox_publisher_all bypass policy
-- checks IS NULL, which misses ''. The publisher then falls through to the
-- outbox_tenant_select policy, which tries to cast '' to UUID, throwing:
--   "invalid input syntax for type uuid: """
--
-- Migration 011 added an AND-guard (IS NOT NULL AND <> '') to outbox_tenant_select
-- but PostgreSQL does NOT guarantee evaluation order in USING clauses, so the
-- cast can still fire before the guard.
--
-- Fix 1: Update outbox_publisher_all to match both NULL and '' (coalesce to '').
-- Fix 2: Replace the AND-guard in outbox_tenant_select with a CASE expression,
--        which DOES guarantee evaluation order.

BEGIN;

-- Publisher bypass: allow SELECT/UPDATE when no real tenant context is bound.
-- coalesce(GUC, '') = '' is true when GUC is NULL (never set) OR '' (from RESET).
DROP POLICY IF EXISTS outbox_publisher_all ON outbox_events;
CREATE POLICY outbox_publisher_all ON outbox_events
  FOR ALL
  USING (
    coalesce(current_setting('app.current_tenant_id', true), '') = ''
  )
  WITH CHECK (
    coalesce(current_setting('app.current_tenant_id', true), '') = ''
  );

-- App reads scoped to current tenant. CASE guarantees evaluation order so the
-- ::uuid cast is never reached when the GUC is absent or empty.
DROP POLICY IF EXISTS outbox_tenant_select ON outbox_events;
CREATE POLICY outbox_tenant_select ON outbox_events
  FOR SELECT
  USING (
    CASE
      WHEN coalesce(current_setting('app.current_tenant_id', true), '') = '' THEN FALSE
      ELSE tenant_id = current_setting('app.current_tenant_id', true)::uuid
    END
  );

COMMIT;
