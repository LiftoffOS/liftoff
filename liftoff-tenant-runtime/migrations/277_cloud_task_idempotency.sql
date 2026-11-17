-- Cloud Tasks execution idempotency.
--
-- Problem: agent runs delivered via Cloud Tasks execute the LLM (executeTask)
-- and then do post-LLM bookkeeping (progressWorkflow). If a post-LLM step
-- throws, the handler returns 500 → Cloud Tasks redelivers the SAME task →
-- the FULL LLM turn re-runs, draining the tenant's Operating Units again, up
-- to max_attempts. There was no per-delivery idempotency.
--
-- Fix: claim each delivery by its GCP-guaranteed, retry-stable identifier
-- (the X-CloudTasks-TaskName header). The result is recorded the instant the
-- LLM turn completes — BEFORE the workflow bookkeeping — so a redelivery
-- replays the stored result and re-drives only the (idempotent) bookkeeping.
-- Net: the LLM runs exactly once per task; the retry just finishes the
-- bookkeeping that failed.
--
--   status='running'  — claimed, LLM may be in flight (concurrent delivery)
--   status='done'     — LLM turn finished; result_payload holds the
--                       TaskExecutionResult to replay on retry
--
-- Rows are only meaningful within the Cloud Tasks retry window
-- (max_retry_duration = 1h); the claim path prunes rows older than 2h.

CREATE TABLE IF NOT EXISTS cloud_task_executions (
  task_name      TEXT PRIMARY KEY,
  tenant_id      UUID NOT NULL,
  agent_id       UUID,
  status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'done')),
  result_payload JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

-- Supports the age-based prune (DELETE WHERE created_at < NOW() - 2h).
CREATE INDEX IF NOT EXISTS idx_cloud_task_exec_created
  ON cloud_task_executions (created_at);
