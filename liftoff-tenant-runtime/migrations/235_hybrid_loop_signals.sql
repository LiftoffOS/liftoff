-- 235_hybrid_loop_signals.sql
--
-- Hybrid execution engine — supporting tables, status enum widenings, and
-- discriminators for the unified runAgentHybridLoop replacement of
-- runAgentLoop + runWorkflowLoop.
--
-- D14: workflow_escalations.kind disambiguates user-facing escalations from
-- system-internal cap-exhaustion records. Existing rows backfill to
-- 'escalation' so prior surfacing behavior is preserved.
ALTER TABLE workflow_escalations
  ADD COLUMN IF NOT EXISTS kind VARCHAR(32) NOT NULL DEFAULT 'escalation'
    CHECK (kind IN ('escalation', 'system_internal'));

-- Index for the operator-inbox query (kind='system_internal' surfaces in the
-- ops view; kind='escalation' continues to surface in /reviews).
CREATE INDEX IF NOT EXISTS workflow_escalations_kind_status_idx
  ON workflow_escalations (kind, status, agent_id);

-- Extend agent_scheduled_invocations.status enum with 'resume_inflight' so we
-- can mark a clarification row "user replied; resume task enqueued but not yet
-- fired" without cancelling it. A second user reply while resume is in flight
-- sees this status and is treated as a normal chat turn instead of triggering
-- a duplicate resume.
ALTER TABLE agent_scheduled_invocations
  DROP CONSTRAINT IF EXISTS agent_scheduled_invocations_status_check;
ALTER TABLE agent_scheduled_invocations
  ADD CONSTRAINT agent_scheduled_invocations_status_check
  CHECK (status IN ('pending', 'fired', 'cancelled', 'errored', 'resume_inflight'));

-- D12: signals table for mid-execution user messages and other interrupts.
-- signal_kind is constrained explicitly (no free-form). Future kinds added by
-- widening the CHECK constraint.
CREATE TABLE IF NOT EXISTS agent_invocation_signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invocation_id UUID NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
  signal_kind   VARCHAR(64) NOT NULL CHECK (signal_kind IN ('user_message')),
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at   TIMESTAMPTZ
);

-- Pending-signals lookup keyed on the hybrid-loop step-boundary point query.
-- Partial index keeps it small (rows are consumed seconds after insert under
-- the expected interrupt cadence).
CREATE INDEX IF NOT EXISTS agent_invocation_signals_pending_idx
  ON agent_invocation_signals (invocation_id, consumed_at)
  WHERE consumed_at IS NULL;

-- Retention: signal rows older than 7 days (consumed or unconsumed) are swept
-- by a periodic job (agent-invocation-signals-cleanup; see hybrid-loop-
-- sweepers.tf). The 7d bound is generous — typical lifetime is seconds. Index
-- supports the cleanup query.
CREATE INDEX IF NOT EXISTS agent_invocation_signals_created_at_idx
  ON agent_invocation_signals (created_at);
