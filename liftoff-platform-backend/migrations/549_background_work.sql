-- 549: work an assistant started and did not wait for.
--
-- An AI team can be handed a background objective: `delegate_task` enqueues
-- it, the run happens on its own, and whoever asked is not blocked. The three
-- platform assistants have no such thing, and this repo already says why in as
-- many words — "the platform assistants are conversational surfaces with no
-- task queue: there is nothing to enqueue a background objective onto".
--
-- The consequence is the one that matters. When there is no suitable AI team
-- to hand something to, an assistant must do the work inside the turn, and a
-- turn is the person waiting. Anything slow holds the whole conversation:
-- there is exactly one assistant in a thread, and while it is working through
-- a long job nobody can talk to it.
--
-- `bring_in_colleague` is not this either. It HANDS THE TURN OVER — the
-- colleague writes the rest of the reply and the caller gets nothing back. It
-- is a hand-off, not a fan-out, and it cannot be used to do two things at
-- once.
--
-- So: work the assistant starts, does not wait for, and collects later. The
-- child runs the same chat machinery on a thread of its own, which is what
-- makes it a real assistant rather than a crippled one — every tool, the whole
-- loop — and its thread is nobody's conversation, so its workings never land
-- in front of the person.
--
-- WHAT IS AND IS NOT KEPT. The brief, the status and the answer. Not the
-- child's transcript: that lives in its own thread like any other, and copying
-- it here would be a second copy that drifts.
--
-- ONE LEVEL. `parent_thread_id` is a conversation, never another piece of
-- background work, and the child is not offered the tool that starts one. Work
-- that can spawn work is a tree nobody bounded, and the cost of getting that
-- wrong is a workspace's whole model budget.

CREATE TABLE background_work (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  -- The conversation that started it, and which collects it.
  parent_thread_id  UUID NOT NULL,
  -- Which assistant's conversation that is. The three have separate thread
  -- tables, so the id alone does not say what it points at.
  surface           TEXT NOT NULL CHECK (surface IN ('liftoff', 'insights', 'team_plan')),
  -- The person it is being done for: the child acts with their permissions,
  -- never with more than the conversation had.
  account_id        UUID NOT NULL REFERENCES accounts(id),
  -- The thread the child works in. Nobody's conversation: it exists so the
  -- child has somewhere to think, and the person never sees it.
  child_thread_id   UUID NOT NULL,
  -- What it was asked to do, in the assistant's words.
  brief             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  -- What came of it. Empty while running.
  answer            TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  CONSTRAINT background_work_finished_has_a_date
    CHECK ((status = 'running') = (finished_at IS NULL))
);

-- What a turn reads: what this conversation has in flight, newest first.
CREATE INDEX idx_background_work_thread ON background_work (tenant_id, parent_thread_id, created_at DESC);

ALTER TABLE background_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_work FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON background_work
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE background_work IS
  'Work an assistant started and did not wait for, so a slow job does not hold the conversation. The child runs the same chat machinery on a thread of its own; only the brief, the status and the answer are kept here.';
COMMENT ON COLUMN background_work.child_thread_id IS
  'Where the child works. Nobody''s conversation: it exists so the child has somewhere to think, and the person never sees it.';
