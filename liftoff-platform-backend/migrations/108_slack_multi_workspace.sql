-- Migration 108: Support multi-workspace Slack installations
--
-- A single Slack app (one per agent) can be installed in multiple
-- workspaces. The previous schema stored one installation per agent,
-- overwriting the bot token when a second workspace installed.
--
-- This migration splits the data:
--   agent_slack_apps     → app definition (one per agent, unchanged)
--   agent_slack_installs → per-workspace installation (many per app)
--
-- The bot token, team ID, and bot user ID move to the installs table.

-- ============================================================================
-- 1. Create the per-workspace installations table
-- ============================================================================

CREATE TABLE agent_slack_installs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_app_id TEXT NOT NULL REFERENCES agent_slack_apps(slack_app_id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  agent_id UUID NOT NULL REFERENCES internal_agents(id),
  slack_team_id TEXT NOT NULL,
  slack_bot_user_id TEXT,
  slack_bot_token_ref TEXT,
  install_status VARCHAR(20) NOT NULL DEFAULT 'installed'
    CHECK (install_status IN ('installed', 'revoked', 'error')),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One installation per agent per workspace
  UNIQUE (agent_id, slack_team_id)
);

CREATE INDEX idx_asi_app ON agent_slack_installs (slack_app_id)
  WHERE install_status = 'installed';
CREATE INDEX idx_asi_tenant ON agent_slack_installs (tenant_id, agent_id);

ALTER TABLE agent_slack_installs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_slack_installs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- 2. Migrate existing installations from agent_slack_apps
-- ============================================================================

INSERT INTO agent_slack_installs (
  slack_app_id, tenant_id, agent_id, slack_team_id,
  slack_bot_user_id, slack_bot_token_ref, install_status, installed_at
)
SELECT
  slack_app_id, tenant_id, agent_id, slack_team_id,
  slack_bot_user_id, slack_bot_token_ref, 'installed', COALESCE(installed_at, NOW())
FROM agent_slack_apps
WHERE install_status = 'installed' AND slack_team_id IS NOT NULL;

-- ============================================================================
-- 3. Clean up agent_slack_apps — keep only app-level fields
-- ============================================================================

-- Drop the unique constraint that assumed one install per agent
ALTER TABLE agent_slack_apps DROP CONSTRAINT IF EXISTS agent_slack_apps_tenant_id_agent_id_key;

-- The install_status on agent_slack_apps now means "app created" vs "app deleted",
-- not "installed in a workspace". Rename to app_status for clarity.
ALTER TABLE agent_slack_apps RENAME COLUMN install_status TO app_status;
ALTER TABLE agent_slack_apps DROP CONSTRAINT IF EXISTS agent_slack_apps_install_status_check;

-- Backfill BEFORE adding the new constraint (existing rows have old values)
UPDATE agent_slack_apps SET app_status = 'active' WHERE app_status IN ('pending', 'installed');
UPDATE agent_slack_apps SET app_status = 'error' WHERE app_status = 'revoked';

-- Now safe to add the constraint — all rows have valid values
ALTER TABLE agent_slack_apps ADD CONSTRAINT agent_slack_apps_app_status_check
  CHECK (app_status IN ('active', 'deleted', 'error'));

-- Re-add the unique constraint (one app per agent, not per workspace)
ALTER TABLE agent_slack_apps ADD CONSTRAINT agent_slack_apps_tenant_agent_unique
  UNIQUE (tenant_id, agent_id);

-- The workspace-specific columns are now redundant on agent_slack_apps.
-- Keep them for now (no data loss) but they're deprecated — reads should
-- go through agent_slack_installs.
COMMENT ON COLUMN agent_slack_apps.slack_team_id IS 'DEPRECATED: use agent_slack_installs';
COMMENT ON COLUMN agent_slack_apps.slack_bot_user_id IS 'DEPRECATED: use agent_slack_installs';
COMMENT ON COLUMN agent_slack_apps.slack_bot_token_ref IS 'DEPRECATED: use agent_slack_installs';
