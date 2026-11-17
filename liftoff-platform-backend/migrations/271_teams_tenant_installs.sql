-- Migration 271: teams_tenant_installs
--
-- Maps an inbound Microsoft Teams Activity (which carries the customer's
-- Azure AD tenant id in channelData.tenant.id) back to a Liftoff tenant, and
-- records the one-time per-tenant install/consent/publish state for the single
-- multi-tenant "Liftoff" Teams bot (ADR-016 Teams analog; one bot serves all
-- agents). RLS-scoped on tenant_id, mirroring agent_slack_installs.

CREATE TABLE teams_tenant_installs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  azure_ad_tenant_id TEXT NOT NULL UNIQUE,           -- inbound activity.channelData.tenant.id → Liftoff tenant
  service_url TEXT,
  consent_state TEXT NOT NULL DEFAULT 'pending',      -- pending|app_consented|published|error
  catalog_teams_app_id TEXT,                          -- id from POST /appCatalogs/teamsApps
  graph_admin_refresh_secret_path TEXT,               -- delegated admin refresh token (re-publish/upgrade)
  app_published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_teams_tenant_installs_aad ON teams_tenant_installs(azure_ad_tenant_id);

ALTER TABLE teams_tenant_installs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teams_tenant_installs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE teams_tenant_installs IS
  'Per-tenant Microsoft Teams install/consent/publish state + Azure AD tenant id → Liftoff tenant mapping for the single multi-tenant Liftoff bot.';
