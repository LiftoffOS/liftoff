-- Stop a routine that fails every single time (J3).
--
-- The stalled-run reconciler is deliberately visible-only: it completes orphans
-- and leaves the agent ACTIVE, because a human should decide what to do about a
-- run that died. That is right for a run. It leaves one case uncovered: a
-- ROUTINE whose every tick fails. Each tick is a fresh Cloud Scheduler fire,
-- nothing counts consecutive failures per routine, and so a misconfigured
-- routine burns its schedule forever, producing an error an hour, indefinitely.
--
-- One row per (agent, routine). The counter resets on any success, so this only
-- trips on a genuine unbroken run of failures, not on a flaky one.
--
-- `failure_paused` is the part that makes the pause stick. The canonical
-- reconciler heals paused companion jobs back to running on its next tick — by
-- design, since a job paused by drift should be repaired. Without a reason
-- recorded somewhere the reconciler can see, a failure-pause would silently
-- undo itself within minutes. The reconciler reads this flag and leaves those
-- labels alone; clearing the flag lets the ordinary heal path bring the job
-- back, which is exactly the unpause behaviour we want and costs no new code.

BEGIN;

CREATE TABLE IF NOT EXISTS routine_failure_state (
  agent_id            UUID        NOT NULL,
  -- The full `companion:<label>` form, matching invocations.triggered_by_label,
  -- so nothing has to re-derive the prefix to join the two.
  triggered_by_label  TEXT        NOT NULL,

  consecutive_failures INTEGER    NOT NULL DEFAULT 0,
  last_failure_at      TIMESTAMPTZ,
  last_error           TEXT,

  failure_paused       BOOLEAN    NOT NULL DEFAULT false,
  paused_at            TIMESTAMPTZ,

  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (agent_id, triggered_by_label)
);

-- The reconciler's question is "which labels of this agent are failure-paused",
-- asked on every reconcile tick.
CREATE INDEX IF NOT EXISTS idx_routine_failure_state_paused
  ON routine_failure_state (agent_id)
  WHERE failure_paused = true;

COMMENT ON TABLE routine_failure_state IS
  'Consecutive-failure count per routine (J3). At the threshold the per-label Cloud Scheduler job is paused and failure_paused is set; the canonical reconciler skips its heal for those labels. Clear the flag to let the next reconcile tick resume the job.';

COMMIT;
