-- Migration 002: Row-Level Security on tenant-scoped tables.
--
-- Pattern matches platform-backend migration 095 + tenant-runtime's RLS
-- setup, but with the connector-service-specific RLS variable name.
-- The connector-service uses `app.tenant_id` (same as tenant-runtime,
-- different from platform-backend's `app.current_tenant_id`) because
-- callers are tenant-runtime-style services making per-tenant requests.

-- ─── Tenant-scoped tables ───────────────────────────────────────────

ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY connectors_tenant_isolation ON connectors
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY connector_credentials_tenant_isolation ON connector_credentials
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Tool classification cache: allow unscoped reads (tenant_id IS NULL
-- = platform-wide classifications) AND per-tenant reads for rows
-- scoped to the caller.
ALTER TABLE tool_classification_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY tool_classification_cache_visibility ON tool_classification_cache
  FOR SELECT
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.tenant_id', true)
  );
CREATE POLICY tool_classification_cache_write ON tool_classification_cache
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- oauth_dynamic_registrations is platform-level (cross-tenant), so it
-- does NOT get RLS — the admin role accesses it directly.

-- ─── Admin role (BYPASSRLS) ──────────────────────────────────────────

-- Creates a role that bypasses RLS — used by background jobs (token
-- refresh, DCR rotation) that need cross-tenant visibility. Role name
-- matches tenant-runtime convention (`admin`, not `liftoff_admin`).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'connector_admin') THEN
    CREATE ROLE connector_admin WITH BYPASSRLS LOGIN;
  END IF;
END $$;

-- GRANT on schema + tables happens during DB provisioning (out of band).
