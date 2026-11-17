-- Migration 105: Agent chat — interactive mode tables
--
-- Creates the schema for 1-on-1 and multi-agent interactive chat between
-- users and internal agents. Supports web UI (SSE streaming) and messaging
-- platforms (Slack, Teams) via channel adapters.
--
-- Part of Phase 2 of the Interactive Mode implementation plan.

-- ============================================================================
-- 1. Agent messaging nickname
-- ============================================================================

-- The name the agent goes by on Slack, Teams, and web chat.
-- Frontend: new section on /teams/update page before Advanced Settings.
-- Section label: "What nickname should they have on Slack and Microsoft Teams?"
-- Default: auto-generated during distillation from the role.
ALTER TABLE internal_agents ADD COLUMN messaging_nickname VARCHAR(35);
-- 35 chars = Slack's app name limit. NULL = auto-derive from role at runtime.

-- Unique per tenant so two agents can't have the same @handle in one workspace.
-- Different tenants CAN have the same nickname (separate Slack workspaces).
CREATE UNIQUE INDEX idx_ia_messaging_nickname_tenant
  ON internal_agents (tenant_id, messaging_nickname)
  WHERE messaging_nickname IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- 2. Chat threads (multi-agent ready from day one)
-- ============================================================================

CREATE TABLE agent_chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  channel VARCHAR(20) NOT NULL DEFAULT 'web'
    CHECK (channel IN ('web', 'slack')),
  external_thread_ref TEXT,  -- Slack thread_ts or other external ID
  title VARCHAR(500),
  rolling_summary JSONB,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_act_tenant ON agent_chat_threads
  (tenant_id, updated_at DESC) WHERE deleted_at IS NULL;

-- Prevents duplicate thread creation from Slack event retries
CREATE UNIQUE INDEX idx_act_external_ref ON agent_chat_threads
  (tenant_id, channel, external_thread_ref)
  WHERE external_thread_ref IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE agent_chat_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_chat_threads
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- 3. Thread participants (many-to-many: threads ↔ agents)
-- ============================================================================

-- Threads have participants, not a single agent_id. For v1 (1-on-1), threads
-- have exactly one participant. Phase 4 (multi-agent) enables multiple.
CREATE TABLE agent_chat_thread_participants (
  thread_id UUID NOT NULL REFERENCES agent_chat_threads(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES internal_agents(id),
  added_by UUID NOT NULL REFERENCES accounts(id),
  role VARCHAR(20) NOT NULL DEFAULT 'participant'
    CHECK (role IN ('participant', 'lead')),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, agent_id)
);

CREATE INDEX idx_actp_agent ON agent_chat_thread_participants (agent_id, thread_id);

-- ============================================================================
-- 4. Chat messages
-- ============================================================================

-- Partitioned by month for retention (CC-8). tenant_id denormalized for RLS (CC-3).
CREATE TABLE agent_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  thread_id UUID NOT NULL REFERENCES agent_chat_threads(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES internal_agents(id),  -- which agent authored (NULL for user/tool messages)
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_calls JSONB,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NOTE: Partitioning (PARTITION BY RANGE) deferred — requires Postgres 11+
-- declarative partitioning and pg_partman for auto-maintenance. The table
-- starts unpartitioned; a follow-up migration adds partitioning once
-- pg_partman is confirmed available on Cloud SQL.

CREATE INDEX idx_acm_thread ON agent_chat_messages (thread_id, created_at);

ALTER TABLE agent_chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_chat_messages
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- 5. Rate limiting (same schema as insights_rate_limit_events)
-- ============================================================================

CREATE TABLE agent_chat_rate_limit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_chat_rl_tenant ON agent_chat_rate_limit_events (tenant_id, created_at);
CREATE INDEX idx_agent_chat_rl_account ON agent_chat_rate_limit_events (account_id, created_at);

ALTER TABLE agent_chat_rate_limit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_chat_rate_limit_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
