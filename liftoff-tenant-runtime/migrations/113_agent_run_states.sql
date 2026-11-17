-- Typed, schema-versioned run state document for each agent invocation.
-- Stores the accumulated AgentRunItem list (tool calls, results, assistant messages,
-- HITL approvals, handoffs) and interruption metadata for approval resume.
-- The engine_sessions table remains as the opaque provider-specific resume blob;
-- this table is the canonical, typed record for a run.

CREATE TABLE IF NOT EXISTS agent_run_states (
  invocation_id   TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  schema_version  TEXT NOT NULL DEFAULT '1.0',
  state           JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_run_states_tenant ON agent_run_states (tenant_id);
