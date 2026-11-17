-- 355: failure_class learns WHICH transient it was.
--
-- 'transient_infra' answered "retry?" and nothing else, so a provider at
-- capacity, a provider 5xx, and a dropped socket were one value, while a
-- rejected API key and an exhausted quota fell through to 'unknown' and read as
-- a crash. The consecutive-failure breaker that pauses an agent could therefore
-- not tell a routine that is broken from a provider that is busy, and stopped
-- healthy routines for outages that cleared themselves.
--
-- The column stays nullable TEXT with no CHECK, exactly as migration 308 set it
-- up: a new class is a code change, not a migration. This migration only
-- re-states the documented set and widens the partial index to the classes an
-- automated retry now selects on.
--
-- 'transient_infra' remains legal so historical rows keep their meaning.
-- classifyFailure returns one of the provider_* classes instead. No backfill: the old rows recorded what was known
-- at the time, and inventing a finer class for them would be a guess.
--
-- Three of the new classes never reach this column. admission_denied, agent_busy
-- and lifecycle_not_active are returned by guards that run BEFORE any
-- invocations row is created, so they exist only on the in-process result, where
-- their job is to tell the caller the run never started. They are listed in the
-- comment below so an operator reading the enumeration is not left wondering why
-- the code has classes the table has never seen.

DROP INDEX IF EXISTS idx_invocations_failure_class;

-- The classes an automated retry selects on. provider_auth and provider_quota
-- are deliberately absent: retrying either one re-sends the same rejected
-- credential or spends against the same empty balance, so they are terminal in
-- the same way task_failed and recovery_declined are.
CREATE INDEX IF NOT EXISTS idx_invocations_failure_class
  ON invocations (failure_class)
  WHERE failure_class IN (
    'transient_infra',
    'timeout',
    'stalled',
    'provider_capacity',
    'provider_server_error',
    'provider_network',
    'context_overflow'
  );

COMMENT ON COLUMN invocations.failure_class IS
  'Granular failure taxonomy for outcome=error runs (nullable; NULL for success/escalated/gated and pre-308 rows). Documented set: provider_capacity | provider_server_error | provider_network | provider_auth | provider_quota | context_overflow | agent_declined | timeout | stalled | tool_error | validation | unknown | task_failed | recovery_declined | limit_reached | transient_infra (legacy). Derived at the completeInvocation site — resolveFailureClass (agent-execution/terminal-state.ts) defaults any unclassified failure to ''unknown'' so no failed run is ever written NULL — with classifyFailure supplying the class on thrown paths and the stalled-run reconciler setting ''stalled''. provider_* split out of transient_infra/unknown because the remediation differs: capacity/server_error/network retry, auth needs re-authentication, quota needs a top-up. context_overflow retries only on a FRESH session. transient_infra is legacy: still legal for historical rows, no longer written. task_failed = a healthy agent reported via report_task_outcome that the task cannot be completed (fix the environment). recovery_declined = the agent could not handle its own anomaly and the recovery advisor terminated the run (fix the agent). Both, plus provider_auth and provider_quota, are terminal and never auto-retried, hence excluded from idx_invocations_failure_class. The code also defines admission_denied | agent_busy | lifecycle_not_active, which are RESULT-LEVEL ONLY: their guards return before an invocations row exists, so those three never appear in this column. Backend-only (diagnostics + auto-retry); NOT on the audit payload. Distinct from reconciliation_status (migration 105).';
