-- 548: a goal the person asked to be held onto, separate from whoever works it.
--
-- Everything durable a person has told an assistant so far has been ATTACHED to
-- something: a memory belongs to an AI team, a workflow step belongs to a team's
-- graph, a thread belongs to a conversation. A person saying "keep an eye on
-- this for me" has had nowhere to land that outlives the conversation it was
-- said in, so it was either turned into a team on the spot or forgotten when the
-- thread went quiet.
--
-- A goal is that landing place, and it is deliberately NOT an executor. It runs
-- nothing and schedules nothing. What it does is survive: it is read back into
-- the assistant's context on every turn, so the next conversation starts knowing
-- the commitment exists. The work still happens the way work already happens —
-- an AI team, a schedule, a person doing it — and the goal is what remembers
-- that it was supposed to.
--
-- TWO STATES, and no third. Active or done. A paused goal is the state that
-- rots: it reads as "being worked" to every list and as "not my problem" to
-- every reader, and nothing ever moves it back. Something is either being worked
-- or it is finished, and a goal nobody wants is deleted rather than parked.
--
-- WHOSE GOAL IT IS. `account_id` is the person who asked for it, and it is not
-- nullable: a goal with no owner is one nobody can be asked about and nobody can
-- close. Tenant-scoped like everything else, so a workspace's goals are its own.
--
-- NOT A PLACE FOR THE WORK ITSELF. `description` holds what the person said, in
-- their words, bounded. Notes, results and history belong where they already
-- belong — the conversation, the team's activity, the ledger — and a goal that
-- accumulated those would become a second copy of them that drifts.

CREATE TABLE tracked_goals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  -- The person who asked for it. Their goal, in their words.
  account_id   UUID NOT NULL REFERENCES accounts(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When it was finished. NULL while active; the two move together.
  completed_at TIMESTAMPTZ,
  CONSTRAINT tracked_goals_done_has_a_date
    CHECK ((status = 'done') = (completed_at IS NOT NULL))
);

-- What every turn reads: this person's active goals, newest first. The partial
-- index is the shape of that read, and a workspace's finished goals never enter
-- it.
CREATE INDEX idx_tracked_goals_active ON tracked_goals (tenant_id, account_id, created_at DESC)
  WHERE status = 'active';

ALTER TABLE tracked_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_goals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tracked_goals
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE tracked_goals IS
  'A goal a person asked to be held onto, read back into the assistant''s context every turn. It executes nothing and schedules nothing: the work happens where work already happens, and this is what remembers it was supposed to.';
COMMENT ON COLUMN tracked_goals.status IS
  'active or done, and there is no third. A paused goal reads as being worked to every list and as nobody''s problem to every reader, and nothing moves it back.';
