-- Repeated routine failures now pause the AGENT, not the routine's scheduler job.
--
-- `failure_paused` (migration 338) recorded a pause that lived only in the
-- runtime: the operator's status column still read Active, the Resume button
-- did not reach it, and the reconciler was coded to leave a flagged routine
-- alone. Clearing the flag was documented as the unpause, but no code path
-- ever set it back to false — so a routine that tripped the threshold could
-- not be restarted from the product at all.
--
-- The stop is now the agent's own status, set through the same call the
-- dashboard's Pause button makes. One state the operator can see, one control
-- that reverses it, and the scheduler follows the status as it always did.
-- The streak columns stay: counting failures is still how the threshold is
-- reached.

DROP INDEX IF EXISTS idx_routine_failure_state_paused;

ALTER TABLE routine_failure_state
  DROP COLUMN IF EXISTS failure_paused,
  DROP COLUMN IF EXISTS paused_at;

COMMENT ON TABLE routine_failure_state IS
  'Consecutive-failure count per routine (J3). At the threshold the AGENT is paused via the control plane, so the pause shows in the status column and the Resume button clears it. This table only counts; it holds no pause state of its own.';
