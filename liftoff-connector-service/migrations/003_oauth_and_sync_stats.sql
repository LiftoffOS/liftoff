-- Migration 003: OAuth flow state + sync stats.
--
-- Adds tables the ported OAuth router + credential lifecycle expect:
--   connector_oauth_states — CSRF state + PKCE verifier (short-lived)
--   connector_sync_stats   — per-connector cumulative sync metrics
--
-- Both are tenant-scoped and get RLS using `app.tenant_id` to match
-- migrations 001 and 002.

-- ─── OAuth state (CSRF + PKCE) ──────────────────────────────────────

CREATE TABLE connector_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT UNIQUE NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  scopes JSONB,
  redirect_uri TEXT,
  code_verifier TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_connector_oauth_states_state ON connector_oauth_states (state);
CREATE INDEX idx_connector_oauth_states_expires ON connector_oauth_states (expires_at);

ALTER TABLE connector_oauth_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_oauth_states_tenant_isolation ON connector_oauth_states
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- ─── Sync stats ─────────────────────────────────────────────────────

CREATE TABLE connector_sync_stats (
  connector_id UUID PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT,
  last_sync_duration_ms BIGINT,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  total_items_synced BIGINT NOT NULL DEFAULT 0,
  total_errors BIGINT NOT NULL DEFAULT 0,
  total_syncs BIGINT NOT NULL DEFAULT 0,
  average_sync_duration_ms BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_connector_sync_stats_tenant ON connector_sync_stats (tenant_id);

ALTER TABLE connector_sync_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_sync_stats_tenant_isolation ON connector_sync_stats
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TRIGGER connector_sync_stats_updated_at BEFORE UPDATE ON connector_sync_stats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
