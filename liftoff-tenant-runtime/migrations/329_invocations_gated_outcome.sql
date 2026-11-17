-- 329_invocations_gated_outcome
-- Let an invocation say "oversight stopped this" instead of reporting success.
--
-- Without it, an invocation blocked by the governance path that creates no approval
-- surfaces nothing on /dashboard/review and records outcome='success' with
-- failure_class NULL. Nothing anywhere distinguishes it from a clean run, so a broken
-- gate is invisible to every query, dashboard and alert.
--
-- 'gated' rather than a new word: audit_logs has used exactly that value for this
-- meaning since migration 016 (CHECK (outcome IN ('success','error','gated'))), so this
-- aligns the two tables instead of inventing a third vocabulary.
--
-- 'escalated' is deliberately NOT reused. It already means "the agent handed the task to
-- a human as part of doing its job" — a normal, successful outcome. Overloading it with
-- "policy blocked this" would make the existing escalation metrics unreadable and hide
-- the very failures this column now needs to expose.

ALTER TABLE invocations DROP CONSTRAINT IF EXISTS invocations_outcome_check;

ALTER TABLE invocations
  ADD CONSTRAINT invocations_outcome_check
  CHECK (outcome IN ('success', 'error', 'escalated', 'gated'));

COMMENT ON COLUMN invocations.outcome IS
  'success | error | escalated (agent handed off to a human by design) | gated (oversight blocked or paused the run — see failure_class for which control fired).';

-- Widening only: every existing row already satisfies the new constraint, so no backfill
-- and no rewrite. Existing rows keep whatever they had, including the historical
-- successes that were really gated — those cannot be recovered and must not be guessed at.
