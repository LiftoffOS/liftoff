-- Migration 272: agent_teams_conversations
--
-- Binds a Microsoft Teams conversation to the active agent and stores the
-- Bot Framework ConversationReference used for streaming + proactive sends.
-- activity.conversation.id natively separates threads: a channel thread reply
-- carries ;messageid=<rootId>, while 1:1 ids are stable. RLS-scoped on tenant_id.

CREATE TABLE agent_teams_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  conversation_id TEXT NOT NULL UNIQUE,              -- activity.conversation.id (carries ;messageid= for channel threads)
  azure_ad_tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,                               -- personal|channel|groupChat
  aad_user_id TEXT,                                  -- from.aadObjectId (personal)
  account_id UUID,                                   -- resolved Liftoff account (for HITL assignee → conversation mapping)
  team_id TEXT,                                      -- channelData.team.id (channel scope) — for Graph reads
  channel_id TEXT,                                   -- channelData.channel.id (channel scope) — for Graph reads
  conversation_reference JSONB NOT NULL,             -- getConversationReference() for streaming + proactive
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_teams_conv_agent ON agent_teams_conversations(tenant_id, agent_id);
CREATE INDEX idx_agent_teams_conv_account ON agent_teams_conversations(tenant_id, agent_id, account_id);

ALTER TABLE agent_teams_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_teams_conversations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE agent_teams_conversations IS
  'Binds a Teams conversation to the active agent + stores the Bot Framework ConversationReference for streaming and proactive messages.';
