-- Park a wake that keeps killing the process that resumes it (C2).
--
-- The wake tables already count `resume_attempts` — every fenced claim
-- increments it — but nothing has ever READ that counter. So a resume that
-- crashes the process is reclaimed by the stale-lease reconciler, crashes it
-- again, and repeats forever. That is the same shape as the control-plane DLQ
-- poison loop from July: an unhandled state, retried indefinitely, taking a
-- healthy service down with it. That one was fixed at the specific handler;
-- this closes the class generically.
--
-- `parked` is terminal-until-a-human-looks. A parked row is NOT retried, the
-- rest of the wake queue keeps flowing, and the row stays visible for an
-- operator to inspect and release (reset resume_attempts, status back to
-- 'pending').
--
-- Additive: every previously accepted status stays accepted, so nothing in
-- flight is affected by this migration.

BEGIN;

ALTER TABLE agent_scheduled_invocations
  DROP CONSTRAINT IF EXISTS agent_scheduled_invocations_status_check;
ALTER TABLE agent_scheduled_invocations
  ADD CONSTRAINT agent_scheduled_invocations_status_check
  CHECK (status IN ('pending', 'resume_inflight', 'settlement_pending', 'fired', 'cancelled', 'errored', 'parked'));

ALTER TABLE wake_wait_sets
  DROP CONSTRAINT IF EXISTS wake_wait_sets_status_check;
ALTER TABLE wake_wait_sets
  ADD CONSTRAINT wake_wait_sets_status_check
  CHECK (status IN ('pending', 'resume_inflight', 'settlement_pending', 'fired', 'cancelled', 'errored', 'parked'));

-- The operator's view: what has been parked, and how hard did it try first.
CREATE INDEX IF NOT EXISTS idx_asi_parked
  ON agent_scheduled_invocations (tenant_id, updated_at)
  WHERE status = 'parked';
CREATE INDEX IF NOT EXISTS idx_wws_parked
  ON wake_wait_sets (tenant_id, updated_at)
  WHERE status = 'parked';

COMMENT ON COLUMN agent_scheduled_invocations.resume_attempts IS
  'Fenced-claim count. Read by the C2 loop breaker: past WAKE_MAX_RESUME_ATTEMPTS the row is parked instead of re-claimed.';
COMMENT ON COLUMN wake_wait_sets.resume_attempts IS
  'Fenced-claim count. Read by the C2 loop breaker: past WAKE_MAX_RESUME_ATTEMPTS the row is parked instead of re-claimed.';

COMMIT;
