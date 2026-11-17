-- A2A inbound service token support (security req #12)
-- External systems calling /api/a2a/agents/:id/rpc use X-Service-Token,
-- validated against inbound_service_token_hash stored on the external_agents record.

ALTER TABLE external_agents
  ADD COLUMN IF NOT EXISTS inbound_service_token_hash   TEXT,
  ADD COLUMN IF NOT EXISTS inbound_service_token_prefix TEXT;

CREATE UNIQUE INDEX idx_external_agents_inbound_token
  ON external_agents (inbound_service_token_hash)
  WHERE inbound_service_token_hash IS NOT NULL AND deleted_at IS NULL;

-- A2A task registry: maps taskId → (agentId, tenantId, requesterKeyId)
-- Used to enforce GetTask/CancelTask ownership (security req #13).
CREATE TABLE a2a_task_registry (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          TEXT        NOT NULL UNIQUE,
  agent_id         UUID        NOT NULL,
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requester_key_id TEXT        NOT NULL,
  context_id       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_a2a_tasks_tenant_agent    ON a2a_task_registry (tenant_id, agent_id);
CREATE INDEX idx_a2a_tasks_requester       ON a2a_task_registry (requester_key_id);
