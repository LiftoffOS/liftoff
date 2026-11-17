-- Stop a delegated task that fails every attempt.
--
-- The stall reconciler detects a run that STOPPED. This is the opposite case: a
-- task the dispatcher keeps retrying, which fails the same way every time and
-- burns a child run per attempt. Nothing counted consecutive failures per task,
-- so a task with a bad objective or an unreachable dependency retried
-- indefinitely.
--
-- Two, not three: a task that failed twice identically is not going to pass on
-- the third, and each attempt is a whole child agent run. (The routine pause in
-- migration 338 uses three because a routine tick is cheap by comparison and
-- transient upstream failures are common there.)
--
-- `blocked` is terminal-until-a-human-looks, the same shape as a parked wake:
-- the task stays visible with its failure count, and the rest of the workflow
-- keeps moving.

BEGIN;

ALTER TABLE child_tasks
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;

COMMENT ON COLUMN child_tasks.consecutive_failures IS
  'Consecutive non-success attempts. Reset on success. At CHILD_TASK_MAX_FAILURES the task is blocked rather than retried again.';

-- The operator view: what is blocked, and how hard it tried first.
CREATE INDEX IF NOT EXISTS idx_child_tasks_blocked
  ON child_tasks (workflow_id, blocked_at)
  WHERE blocked_at IS NOT NULL;

COMMIT;
