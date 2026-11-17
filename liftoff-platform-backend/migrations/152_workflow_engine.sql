-- Durable cross-agent workflow engine tables
-- workflow_definitions: versioned DAG definitions (nodes + edges as JSONB)
-- workflow_runs: live run state with current_node_ids array
-- workflow_step_executions: per-node execution state, tracks task_id
-- workflow_step_events: immutable audit trail, one row per state transition

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  name         VARCHAR(255) NOT NULL,
  description  TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  definition   JSONB NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'active', 'archived')),
  created_by   VARCHAR(255) NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_definitions_tenant ON workflow_definitions(tenant_id, status);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  definition_id       UUID NOT NULL REFERENCES workflow_definitions(id),
  definition_version  INTEGER NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
  context             JSONB NOT NULL DEFAULT '{}',
  current_node_ids    TEXT[] DEFAULT '{}',
  triggered_by        VARCHAR(255) NOT NULL,
  trigger_ref         VARCHAR(255),
  started_at          TIMESTAMPTZ DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_runs_tenant_status ON workflow_runs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_wf_runs_definition ON workflow_runs(definition_id);

CREATE TABLE IF NOT EXISTS workflow_step_executions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       UUID NOT NULL REFERENCES workflow_runs(id),
  node_id      VARCHAR(255) NOT NULL,
  agent_id     UUID NOT NULL REFERENCES internal_agents(id),
  task_id      VARCHAR(255),
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  input        JSONB,
  output       JSONB,
  error        TEXT,
  attempt      INTEGER NOT NULL DEFAULT 1,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_steps_run ON workflow_step_executions(run_id);
CREATE INDEX IF NOT EXISTS idx_wf_steps_task_id ON workflow_step_executions(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_step_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL,
  step_execution_id  UUID NOT NULL REFERENCES workflow_step_executions(id),
  event_type         VARCHAR(50) NOT NULL
                       CHECK (event_type IN ('dispatched', 'completed', 'failed', 'retried', 'hitl_gated', 'hitl_approved', 'skipped')),
  payload            JSONB,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wf_step_events_run ON workflow_step_events(run_id, created_at);
