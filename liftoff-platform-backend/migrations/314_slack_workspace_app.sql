-- Migration 314: Liftoff workspace Slack app (ADR-040)
--
-- ONE Slack app per environment, installed once per customer workspace.
-- Agents are never registered with Slack: inbound routing happens via
-- slack_conversation_agents bindings, and an agent-authored message names the
-- speaking agent in its text. Supersedes the per-agent app model (agent_slack_apps /
-- agent_slack_installs, ADR-016), whose tables remain readable for existing
-- installs.

-- ── Workspace installs ───────────────────────────────────────────────────────
-- One row per (customer workspace) install of the Liftoff app. Webhooks carry
-- only team_id, so the webhook entrypoint resolves the tenant under
-- withAdminScope via slack_team_id (mirrors teams_tenant_installs /
-- findTenantByAadTenant).

CREATE TABLE slack_workspace_installs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slack_team_id TEXT NOT NULL UNIQUE,                -- inbound event team_id → Liftoff tenant
  slack_team_name TEXT,
  slack_bot_user_id TEXT,                            -- the app's bot user in this workspace
  slack_bot_token_secret_path TEXT,                  -- Secret Manager /versions/latest path
  install_status TEXT NOT NULL DEFAULT 'installed',  -- installed|revoked|error
  installed_by_account_id UUID REFERENCES accounts(id),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_slack_ws_installs_tenant ON slack_workspace_installs(tenant_id);

ALTER TABLE slack_workspace_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_workspace_installs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON slack_workspace_installs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE slack_workspace_installs IS
  'Per-workspace install of the single Liftoff Slack app (ADR-040): slack team → tenant mapping + workspace bot token path.';

-- ── Conversation/agent bindings ──────────────────────────────────────────────
-- Routing state (mirrors agent_teams_conversations), plus thread granularity:
--   thread_root_ts IS NULL  → channel-level binding (DM top-level messages, or
--                             a whole channel bound to one agent)
--   thread_root_ts NOT NULL → that one thread routes to agent_id (escalation
--                             cards + concurrent per-agent DM threads)
-- agent_id is the INTERNAL agent id (internal_agents.id — INV-PB-009; the
-- runtime id space never appears in platform-backend tables).

CREATE TABLE slack_conversation_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES internal_agents(id) ON DELETE CASCADE,
  slack_team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,                          -- DM (D…), channel (C…) or group (G…) id
  thread_root_ts TEXT,                               -- NULL = channel/DM-level binding
  scope TEXT NOT NULL,                               -- dm|channel|group
  slack_user_id TEXT,                                -- DM owner (dm scope)
  account_id UUID REFERENCES accounts(id),           -- resolved Liftoff account (HITL assignee → DM mapping)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One binding per (workspace, channel, thread). COALESCE folds the NULL
-- thread_root_ts (channel-level binding) into a single slot per channel.
CREATE UNIQUE INDEX uq_slack_conv_agents_binding
  ON slack_conversation_agents(slack_team_id, channel_id, COALESCE(thread_root_ts, ''));
-- Serves the agent_id FK's ON DELETE CASCADE (agent deletion would otherwise
-- seq-scan this table); no read query uses it today.
CREATE INDEX idx_slack_conv_agents_agent ON slack_conversation_agents(agent_id);

ALTER TABLE slack_conversation_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_conversation_agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON slack_conversation_agents
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE slack_conversation_agents IS
  'Routes Liftoff workspace-app Slack conversations to agents: channel/DM-level bindings (thread_root_ts NULL) plus per-thread bindings (ADR-040).';

-- ── Review-card token provenance ─────────────────────────────────────────────
-- chat.update requires the SAME bot that posted a card. Rows posted by the
-- workspace app must resolve the workspace token, not a per-agent install
-- token. Plain ADD COLUMN with a DEFAULT — safe on this RLS-FORCED table (no
-- FK validation pass; see the RLS-forced migration notes in docs/rls.md).

ALTER TABLE review_slack_messages
  ADD COLUMN posted_via TEXT NOT NULL DEFAULT 'agent_app';

COMMENT ON COLUMN review_slack_messages.posted_via IS
  'Which token posted the card: agent_app (per-agent install, ADR-016) | workspace_app (Liftoff workspace app, ADR-040).';
