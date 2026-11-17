-- 308: invocations.failure_class — granular failure taxonomy.
--
-- invocations.outcome is only ('success','error','escalated'), so every failure
-- class (transient LLM 529, connector 502, agent-declined, timeout, stall) collapses
-- into one 'error' bucket. failure_class de-coarsens it so the stalled-run reconciler
-- (§4.8-style sweep), a future auto-retry, and diagnostics can act selectively.
-- Nullable, no CHECK (new classes don't need a migration). Documented set:
--   transient_infra | agent_declined | timeout | stalled | tool_error | validation | unknown
-- Distinct from reconciliation_status (migration 105 — the billing-token axis).

ALTER TABLE invocations ADD COLUMN IF NOT EXISTS failure_class TEXT;

-- The classes the stalled-run reconciler + a future auto-retry select on.
CREATE INDEX IF NOT EXISTS idx_invocations_failure_class
  ON invocations (failure_class)
  WHERE failure_class IN ('transient_infra', 'timeout', 'stalled');

-- Stalled-run reconciler scan support: incomplete (still-running / orphaned) runs.
CREATE INDEX IF NOT EXISTS idx_invocations_incomplete
  ON invocations (started_at)
  WHERE outcome IS NULL AND completed_at IS NULL;

COMMENT ON COLUMN invocations.failure_class IS
  'Granular failure taxonomy for outcome=error runs (nullable; NULL for success/escalated and pre-308 rows). Documented set: transient_infra | agent_declined | timeout | stalled | tool_error | validation | unknown. Derived at the error-path completeInvocation site (classifyFailure) and set to ''stalled'' by the stalled-run reconciler. Backend-only (diagnostics + future auto-retry); NOT on the audit payload. Distinct from reconciliation_status (migration 105).';
