-- 293_agent_trajectories_index
-- Index of trajectories written to gs://trajectories-${env}/.
-- gcs_path is NULL when the quality filter skipped the GCS write (no
-- reasoning blocks); the row still exists so reconciliation (Part 7 §E)
-- can join invocations against trajectories.

CREATE TABLE IF NOT EXISTS agent_trajectories (
  tenant_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  invocation_id uuid NOT NULL,
  /** Populated for delegated children + nested code_session inner runs.
   *  NULL for top-level invocations. Matches invocations.parent_invocation_id. */
  parent_invocation_id uuid,
  /** Populated for nested code_session inner runs. NULL otherwise. */
  nested_kind text CHECK (nested_kind IS NULL OR nested_kind = 'code_session'),
  gcs_path text,                              -- NULL when has_reasoning = false
  bytes bigint NOT NULL DEFAULT 0,
  turn_count int NOT NULL,
  completed boolean NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  has_reasoning boolean NOT NULL,
  schema_version text NOT NULL DEFAULT '1.0',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, invocation_id)
);
CREATE INDEX idx_trajectories_agent ON agent_trajectories(tenant_id, agent_id, created_at DESC);
CREATE INDEX idx_trajectories_parent ON agent_trajectories(parent_invocation_id)
  WHERE parent_invocation_id IS NOT NULL;
CREATE INDEX idx_trajectories_has_reasoning ON agent_trajectories(has_reasoning, created_at DESC);
CREATE INDEX idx_trajectories_schema_version ON agent_trajectories(schema_version, created_at DESC);
