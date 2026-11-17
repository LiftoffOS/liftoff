-- Migration 426: the browser-activity trail of a Liftoff conversation.
--
-- A Liftoff thread's transcript carries only speech. The browser work a turn
-- does — the instruction handed to run_browser_task, the pages navigated to,
-- the moment the person takes the keyboard — exists only inside the turn's
-- tool loop and vanishes when the turn ends. For a browser-dependent piece of
-- work, that is most of the mechanism, and the Chief AI Officer cannot build a
-- team from a conversation whose mechanism it cannot see.
--
-- So each browser tool call leaves one compact row: which tool, what it was
-- told to do, one line on what happened, and whether the person took over.
-- Boundaries only, never contents: what the person did while driving is not
-- observed anywhere in this estate, deliberately — takeovers skew toward
-- sign-ins and other private steps, and a keystroke log would put secrets into
-- a table that later feeds a distill prompt.
--
-- Deliberately NOT rows in liftoff_chat_messages. That table feeds the
-- frontend list, the /share/<id> shares and the model-history assembly, and
-- every one of those readers would need to learn to filter a new kind of row.
-- This table has exactly one writer (the browser-tool dispatch in the Liftoff
-- chat service) and one reader (the source-conversation read workforce-service
-- calls on the Chief AI Officer's behalf), which keeps the blast radius of a
-- non-speech record at two call sites.
--
-- instruction and outcome are capped by the writer, not by a CHECK: a row that
-- arrives too long should be truncated and kept, never rejected — a trail with
-- a hole where the longest step was is the failure this table exists to end.

CREATE TABLE liftoff_browser_activity (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  thread_id        UUID NOT NULL REFERENCES liftoff_chat_threads(id) ON DELETE CASCADE,
  -- The neutral tool name (run_browser_task, navigate_browser_session, ...).
  -- Never a browser vendor: which vendor served the call is the router's
  -- decision at call time and has no place in a workflow record.
  tool             TEXT NOT NULL,
  -- What the tool was told to do: the task instruction or the URL.
  instruction      TEXT NOT NULL,
  -- One line on how it ended, in the words the model was shown.
  outcome          TEXT NOT NULL,
  -- The person took the keyboard during this call. The row's instruction and
  -- outcome then bracket the unseen segment: where the browser was when
  -- control changed hands, and where it came back.
  person_took_over BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The one read this table serves: a thread's trail, oldest first.
CREATE INDEX idx_liftoff_browser_activity_thread
  ON liftoff_browser_activity (thread_id, created_at);

-- RLS written out per table, as migration 348 does for the rest of this
-- surface: the DO-loops that enabled RLS estate-wide (095, 287, 289) have
-- already run and will never see a table created after them.
ALTER TABLE liftoff_browser_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE liftoff_browser_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON liftoff_browser_activity
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
