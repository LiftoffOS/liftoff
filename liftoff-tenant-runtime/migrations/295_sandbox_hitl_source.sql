-- migrations/295_sandbox_hitl_source.sql
--
-- Increment B: governed connector calls that originate from agent-authored
-- sandbox CODE (not the LLM tool loop). These reach the connector via
-- /internal/sandbox/mcp/dispatch and must honor the SAME workspace /oversight
-- HITL gate as an LLM tool call. When gated, the dispatch creates a pending
-- approval that surfaces on /dashboard/review and is executed server-side on
-- approval (so it survives sandbox teardown), keyed on idempotency_key.
--
-- workflow_id/task_id stay NOT NULL. Sandbox dispatch has no agent
-- ExecutionContext, so the producer generates workflow/task UUIDs and upserts
-- the parent workflows + workflow_tasks rows ON CONFLICT DO NOTHING — the same
-- pattern escalation-helper.ts uses for scheduled/SDK executions whose
-- generated UUIDs lack parent rows. No schema-invariant change to actions /
-- hitl_approval_requests.

-- Discriminator on approval requests. Default 'agent' = the existing LLM path.
-- 'sandbox_code' rows are resumed by executing the connector server-side at
-- approval time (NOT by resuming an agent run), so the approve/reject handlers
-- branch on this.
ALTER TABLE hitl_approval_requests
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'agent'
    CHECK (source IN ('agent', 'sandbox_code'));

-- Fast path for the await-approval poll and the stale-approval sweeper.
CREATE INDEX IF NOT EXISTS idx_hitl_approvals_sandbox_pending
  ON hitl_approval_requests (idempotency_key)
  WHERE source = 'sandbox_code' AND status = 'pending';
