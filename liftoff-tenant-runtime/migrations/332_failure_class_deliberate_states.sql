-- Migration 332: extend the invocations.failure_class taxonomy with the two
-- DELIBERATE failure classes.
--
-- Comment-only. failure_class is a nullable TEXT column with no CHECK
-- constraint (migration 308) precisely so "new classes don't need a
-- migration" — but the documented set lives in the column COMMENT, and a
-- taxonomy that silently drifts from the code is how the previous set stopped
-- describing reality.
--
-- Motivation: classifyFailure only ever ran on the THROWN path
-- (agent-execution/service.ts error-salvage catch). Every failure that
-- RETURNED instead of throwing — which is exactly the set of deliberate,
-- reasoned failures — was written with a NULL class, indistinguishable from a
-- crash to the rerun gate, invocation_failed_total, and every success-rate
-- query. Classification is now total: a failure state with no explicit class
-- is persisted as 'unknown', so `WHERE failure_class = 'unknown'` is a live
-- to-do list of unclassified terminal sites rather than an invisible gap.
--
-- The two new classes are deliberate outcomes and are deliberately EXCLUDED
-- from idx_invocations_failure_class (transient_infra | timeout | stalled) —
-- that index backs the stalled-run reconciler and a future auto-retry, and
-- neither of these should ever be auto-retried: re-running a task a reasoning
-- agent already concluded is impossible burns a full run to reach the same
-- answer.

BEGIN;

COMMENT ON COLUMN invocations.failure_class IS
  'Granular failure taxonomy for outcome=error runs (nullable; NULL for success/escalated/gated and pre-308 rows). Documented set: transient_infra | agent_declined | timeout | stalled | tool_error | validation | unknown | task_failed | recovery_declined. Derived at the completeInvocation site — resolveFailureClass (agent-execution/terminal-state.ts) defaults any unclassified failure to ''unknown'' so no failed run is ever written NULL — with classifyFailure supplying the class on thrown paths and the stalled-run reconciler setting ''stalled''. task_failed = a healthy agent reported via report_task_outcome that the task cannot be completed (fix the environment). recovery_declined = the agent could not handle its own anomaly and the recovery advisor terminated the run (fix the agent). Both are deliberate, hence terminal and never auto-retried, and are excluded from idx_invocations_failure_class. Backend-only (diagnostics + future auto-retry); NOT on the audit payload. Distinct from reconciliation_status (migration 105).';

COMMIT;
