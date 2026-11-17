-- A deadline for a routine run that is looping rather than waiting.
--
-- The overlap guard stops tick N+1 starting while tick N is alive. It does not
-- stop tick N being alive forever. A routine caught in a retry loop holds its
-- own schedule closed indefinitely and burns tokens the whole time — the
-- runaway case the Hermes cron set bounds with a hard interrupt.
--
-- The distinction that matters, and that an earlier pass of this work got
-- wrong: a run WAITING on a human (HITL approval, a clarification answer, a
-- wake) must never be killed — it is not consuming anything, and killing it
-- strands the person's decision. A run that is ACTIVE past its deadline is a
-- different animal. The stalled-run reconciler already distinguishes these,
-- because it already declines to sweep runs with a pending scheduled resume, so
-- it is the right enforcer.
--
-- Nullable and only ever set for routine (companion-label) runs, so nothing
-- else acquires a deadline by accident.

BEGIN;

ALTER TABLE invocations
  ADD COLUMN IF NOT EXISTS active_deadline_at TIMESTAMPTZ;

COMMENT ON COLUMN invocations.active_deadline_at IS
  'When a routine run stops being worth letting continue. Enforced by the stalled-run reconciler, which already excludes runs that are legitimately paused. NULL for everything that is not a routine run.';

-- The reconciler asks "which routine runs are past their deadline and still
-- active", so the index carries the predicate.
CREATE INDEX IF NOT EXISTS idx_invocations_active_deadline
  ON invocations (active_deadline_at)
  WHERE active_deadline_at IS NOT NULL AND completed_at IS NULL;

COMMIT;
