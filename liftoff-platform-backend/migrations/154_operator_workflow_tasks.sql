-- Operator dashboard: workflow task-level tracking
-- Individual tasks within a workflow; used for queue depth / p95-latency metrics.
-- workflow_id is intentionally unkeyed: the workflows table is owned by liftoff-tenant-runtime.

CREATE TABLE IF NOT EXISTS workflow_tasks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID        NOT NULL,
  tenant_id   UUID        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  status      TEXT        NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_workflow   ON workflow_tasks (workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_status_ts  ON workflow_tasks (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_tenant     ON workflow_tasks (tenant_id);
