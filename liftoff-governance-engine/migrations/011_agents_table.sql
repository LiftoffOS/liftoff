-- Migration 011: agents lifecycle cache for governance admission checks.
--
-- checkAgentLifecycle in src/admission/service.ts queries:
--   SELECT lifecycle FROM agents WHERE id = $1
-- against a table that has never existed in any prior migration. Every
-- Preflight call that includes an agentId returns HTTP 500 with
-- "relation 'agents' does not exist" until this table exists.
--
-- This table is a local governance-engine cache of agent lifecycle state
-- materialised from platform-backend via the control-plane-events Pub/Sub
-- topic (agent-lifecycle-subscriber.ts). Not a source of truth — writes
-- come exclusively from the subscriber.
--
-- lifecycle values match platform-backend internal agent status, uppercased:
--   ACTIVE   — agent is running and can execute (platform: 'active')
--   DRAFT    — agent is in draft, not yet deployed (platform: 'draft')
--   PAUSED   — agent has been paused by the operator (platform: 'paused')
--   DELETED  — agent was deleted (platform: 'tenant.internal_agent.deleted')

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT        PRIMARY KEY,           -- platform-backend internal agent id
  tenant_id       TEXT        NOT NULL,
  lifecycle       TEXT        NOT NULL DEFAULT 'ACTIVE',
  entity_version  INTEGER     NOT NULL DEFAULT 1,    -- monotonic counter from event payload
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_tenant
  ON agents (tenant_id);
