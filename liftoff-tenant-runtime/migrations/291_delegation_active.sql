-- 291_delegation_active
-- Adds delegation_depth to invocations and creates the DB-backed delegation
-- registry. Module-level Map would not work — tenant-runtime runs as
-- multiple Cloud Run instances; the registry is the cross-instance
-- kill-switch surface.

ALTER TABLE invocations ADD COLUMN IF NOT EXISTS delegation_depth int;
-- Nullable; resolver tolerates NULL (defaults to 0). Only delegated children
-- get a non-NULL value, populated at INSERT time inside delegateToAgent.

CREATE TABLE IF NOT EXISTS delegation_active (
  child_invocation_id uuid PRIMARY KEY,
  parent_invocation_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  task_index int NOT NULL,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  interrupted boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'interrupted', 'timeout')),
  -- Result columns: written by runDelegationChild at terminal status so
  -- reawaitInFlightDelegations (§C3) can rebuild DelegationResult[] without
  -- in-memory closures.
  result_summary text,
  result_usage jsonb,
  anomalies jsonb
);
CREATE INDEX idx_delegation_active_tenant_running ON delegation_active(tenant_id) WHERE status = 'running';
CREATE INDEX idx_delegation_active_parent ON delegation_active(parent_invocation_id);
