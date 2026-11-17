-- Give the failure limit its own status instead of borrowing `blocked`.
--
-- Migration 340 added a per-task failure limit and parked the task as
-- `blocked`. That was wrong, and the wrongness was not in the limit — it was in
-- the word. `blocked` already meant something else and had meant it since the
-- task graph shipped: **waiting on dependencies** (`service.ts` sets it on every
-- child that has a `dependsOn`). Two meanings on one value produced two
-- separate defects, in opposite directions:
--
--   1. The async advance path un-blocks any `blocked` child whose dependencies
--      have all completed. A task that ran and failed twice necessarily HAS
--      completed dependencies, so the next sibling completion moved it back to
--      `pending` and it burned another child run — then re-blocked, then
--      un-blocked on the next graph event. The two-attempt limit held in sync
--      graphs (which never enter that path) and leaked in exactly the async
--      graphs it was written for.
--
--   2. `isTerminalChildStatus` was widened to count `blocked` as terminal,
--      which is true of a failure-blocked task and FALSE of a dependency-
--      blocked one. A fan-in could therefore treat a child that had not run yet
--      as finished and resume the parent early — a worse failure than the one
--      being fixed, and introduced by the fix.
--
-- So: `abandoned`. Terminal, distinct, and self-describing — the same word the
-- outbound-webhook queue uses for the same idea (out of attempts, terminal,
-- still visible). `blocked` goes back to meaning only what it always meant.
--
-- The lesson worth keeping: a status value is an interface. Adding a meaning to
-- one already in use is an API change disguised as a one-word diff, and every
-- query written against the old meaning silently becomes wrong.

BEGIN;

-- Rows this codebase wrote as failure-blocked. `blocked_at` is the
-- discriminator and it is exact: nothing else ever sets it — dependency-blocked
-- rows are written by `updateStatus(id, 'blocked')`, which touches only
-- `status` and `updated_at`.
UPDATE child_tasks
   SET status = 'abandoned'
 WHERE status = 'blocked'
   AND blocked_at IS NOT NULL;

COMMENT ON COLUMN child_tasks.blocked_at IS
  'When the per-task failure limit was reached and the task was abandoned. NULL for a task blocked on dependencies, which is an ordinary waiting state.';

COMMENT ON COLUMN child_tasks.consecutive_failures IS
  'Consecutive non-success attempts. Reset on success. At CHILD_TASK_MAX_FAILURES the task is ABANDONED (terminal) rather than retried again — never `blocked`, which means waiting on dependencies.';

-- The operator view. Renamed off `blocked` so the index name does not carry the
-- old confusion forward either.
DROP INDEX IF EXISTS idx_child_tasks_blocked;
CREATE INDEX IF NOT EXISTS idx_child_tasks_abandoned
  ON child_tasks (workflow_id, blocked_at)
  WHERE blocked_at IS NOT NULL;

COMMIT;
