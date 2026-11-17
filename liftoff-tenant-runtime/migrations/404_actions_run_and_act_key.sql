-- "Have I done this in the run I am in?" needs a run, and an act.
--
-- THE RUN. `trace_id` has stood in for the run. It is not one: a resumed run
-- (after an approval, an answer, a wake) carries a different trace id from
-- the process that paused, so an act completed before the pause and the same
-- act proposed after it are in two different "runs" as far as the ledger can
-- tell. `invocation_id` is the identity that survives a resume. Nullable,
-- because rows written before this column exist and some writers have no
-- invocation to name; a lookup prefers it and falls back to trace_id.
--
-- THE ACT. `target_ref` names the THING acted on and is keyed by connector
-- type, which is right for "everything I have ever done to this pull
-- request" and wrong for "is this the same send": the same email through the
-- bound Gmail tool and through a hidden-vendor capability names the thing
-- two ways. `act_key` names the act — `<operation>|<target path>` — so that
-- the path half is the same string whichever way the send went, and the
-- operation half tells a send from a reply from a schedule. Additive:
-- target_ref keeps every reader it has.
--
-- THE CLAIM. A capability write is claimed before it is dispatched, and the
-- claim is what a second identical call in the same run runs into. A claim
-- whose owner died mid-dispatch must eventually be re-armable, which needs
-- the time the CURRENT owner took it — `created_at` is the first claim's and
-- never moves.
ALTER TABLE actions ADD COLUMN IF NOT EXISTS invocation_id UUID;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS act_key TEXT;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN actions.invocation_id IS
  'The run this action belongs to; survives a pause and resume where trace_id '
  'does not. NULL for rows written before the column existed and for writers '
  'with no invocation in scope — a lookup then falls back to trace_id.';
COMMENT ON COLUMN actions.claimed_at IS
  'When the current owner of this idempotency key claimed it. Set on claim and '
  'on re-arm; a pending row older than the in-flight window by this clock may '
  'be re-armed by another caller. NULL for rows the gateway records without '
  'a claim.';
COMMENT ON COLUMN actions.act_key IS
  'Identity of the ACT: <operation>|<target path>. The path half is shared by '
  'every route to the same outward act (a direct connector tool and a '
  'capability); the operation half separates a send from a reply. NULL when '
  'the payload names no target.';

-- The duplicate lookup scopes to one run and matches on the act; both are
-- equality columns here, so the scan is this run's keyed rows and nothing
-- else. Partial: a row with no act_key cannot be matched on it.
CREATE INDEX IF NOT EXISTS idx_actions_run_act
  ON actions (tenant_id, agent_id, invocation_id, act_key)
  WHERE act_key IS NOT NULL;
