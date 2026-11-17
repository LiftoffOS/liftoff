-- Migration 001: Initial connector-service schema.
--
-- Tables:
--   connectors                  — per-tenant connector instances. Incorporates
--                                 the `config JSONB` column required for
--                                 per-instance per-account config (Snowflake
--                                 accountIdentifier, Databricks workspaceUrl).
--                                 Extracted from tenant-runtime migration.
--   connector_credentials       — credential storage keyed by connector id.
--                                 Actual token values live in Secret Manager
--                                 (connector-{tenantId}-{connectorId}); this
--                                 row records the flow kind + secret name.
--   oauth_dynamic_registrations — platform-level DCR registrations.
--                                 Extracted from platform-backend migration
--                                 125 (RFC 7591 DCR).
--   tool_classification_cache   — tool sensitivity categories keyed by
--                                 (tool_name, integration_type, tenant_id).
--                                 Matches platform-backend migration 081+
--                                 schema including the post-083a
--                                 tool_description_hash TEXT widening.
--
-- RLS enabled on tenant-scoped tables (migration 002 defines policies).

-- ─── Connectors ─────────────────────────────────────────────────────

CREATE TABLE connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, type, name)
);

CREATE INDEX idx_connectors_tenant_type ON connectors (tenant_id, type);
CREATE INDEX idx_connectors_status ON connectors (status) WHERE status != 'active';

-- ─── Connector credentials (pointer to Secret Manager) ──────────────

CREATE TYPE auth_flow_kind AS ENUM (
  'static_oauth',
  'dynamic_client_registration',
  'api_key',
  'keypair',
  'none'
);

CREATE TABLE connector_credentials (
  connector_id UUID PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  flow_kind auth_flow_kind NOT NULL,
  -- Secret Manager secret name where the access token / api key lives.
  -- Pattern: connector-{tenantId}-{connectorId}.
  secret_name TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Expiry hint so the service can proactively refresh.
  expires_at_epoch_sec BIGINT,
  -- Vendor-specific extra fields (workspace_id, team_id, etc).
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_connector_credentials_tenant ON connector_credentials (tenant_id);

-- ─── OAuth Dynamic Client Registration (platform-level, cross-tenant) ──

-- From platform-backend migration 125_oauth_dynamic_registrations.sql.
-- DCR registrations are platform-level (shared across tenants) because
-- the OAuth client is registered once per issuer per deployment.
CREATE TABLE oauth_dynamic_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Issuer URL (authorization server).
  issuer TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  -- Registered redirect URIs.
  redirect_uris TEXT[] NOT NULL,
  -- Scopes granted at registration time.
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Scheduled rotation; null = never.
  rotate_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth_dcr_rotate_after ON oauth_dynamic_registrations (rotate_after)
  WHERE rotate_after IS NOT NULL;

-- ─── Tool classification cache ──────────────────────────────────────

-- From platform-backend migrations 028 + 081 + 083a. tool_description_hash
-- is TEXT (widened from CHAR(12)) so seed markers like 'vendor_seed_v1' fit.
CREATE TABLE tool_classification_cache (
  tool_name TEXT NOT NULL,
  integration_type TEXT NOT NULL,
  tool_description_hash TEXT NOT NULL,
  categories TEXT[] NOT NULL DEFAULT '{}',
  draft_variant TEXT,
  reviewed_by TEXT,
  is_manual_override BOOLEAN NOT NULL DEFAULT false,
  -- Global (tenant-neutral) rows use the sentinel '__global__'. This
  -- keeps the primary key simple (no COALESCE-based expression PK which
  -- Postgres does not allow) while preserving the post-081 semantics.
  tenant_id TEXT NOT NULL DEFAULT '__global__',
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tool_name, tenant_id)
);

CREATE INDEX idx_tool_classification_integration
  ON tool_classification_cache (integration_type);
CREATE INDEX idx_tool_classification_unreviewed
  ON tool_classification_cache (reviewed_by) WHERE reviewed_by IS NULL;

-- ─── Updated-at triggers ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER connectors_updated_at BEFORE UPDATE ON connectors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER connector_credentials_updated_at BEFORE UPDATE ON connector_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER oauth_dcr_updated_at BEFORE UPDATE ON oauth_dynamic_registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
