-- 220: agent_scheduled_invocations — observability + cancellation table for
-- deferred agent execution tasks.
--
-- Rows are written by enqueueAgentExecution callers BEFORE the Cloud Task is
-- created (so a crash between row insert and createTask leaves a "pending"
-- row the next reconciler tick will clean up) and updated to 'fired' when the
-- receiver handler runs (markFiredByInvocationId).
--
-- companion to schedule_followup and workflow delay resumes; workflow delay steps (workflow delay resumes) and the
-- schedule_followup tool both target this table.

CREATE TABLE IF NOT EXISTS agent_scheduled_invocations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL,
  agent_id                    UUID NOT NULL,
  thread_id                   UUID,
  context_ref                 TEXT NOT NULL,         -- '{workflowId}:{stepId}' for delay, 'followup:{recordId}' for schedule_followup, etc.
  schedule_key                TEXT NOT NULL,         -- ISO timestamp truncated to minute, dedup key
  fires_at                    TIMESTAMPTZ NOT NULL,
  objective                   TEXT NOT NULL,
  cloud_task_name             TEXT,                  -- nullable until createTask returns
  status                      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fired', 'cancelled', 'errored')),
  scheduled_by_invocation_id  TEXT,                  -- the invocation that called schedule_followup / suspended into delay
  workflow_resume_payload     JSONB,                 -- workflow_id + invocation_id for delay-step resumes
  fired_at                    TIMESTAMPTZ,
  cancelled_at                TIMESTAMPTZ,
  last_error                  TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup by invocation when the resume handler marks fired.
CREATE INDEX IF NOT EXISTS idx_asi_scheduled_by_invocation
  ON agent_scheduled_invocations (scheduled_by_invocation_id)
  WHERE scheduled_by_invocation_id IS NOT NULL;

-- Workflow cancel scans pending rows by context_ref LIKE 'workflowId:%'.
CREATE INDEX IF NOT EXISTS idx_asi_pending_by_context
  ON agent_scheduled_invocations (tenant_id, context_ref)
  WHERE status = 'pending';

-- Sweep "stuck pending past fires_at" rows.
CREATE INDEX IF NOT EXISTS idx_asi_pending_fires_at
  ON agent_scheduled_invocations (fires_at)
  WHERE status = 'pending';

-- Per-tenant agent listing for the /api/internal/agents/:agentId/triggers view.
CREATE INDEX IF NOT EXISTS idx_asi_tenant_agent
  ON agent_scheduled_invocations (tenant_id, agent_id, status);

COMMENT ON TABLE agent_scheduled_invocations IS
  'Tracks scheduled future agent invocations (schedule_followup tool + workflow delay steps workflow delay resumes). Status transitions: pending -> fired | cancelled | errored.';
