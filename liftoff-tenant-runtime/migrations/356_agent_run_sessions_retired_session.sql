-- 356: agent_run_sessions.retired_session_id — say when a session was abandoned.
--
-- A run that ends by reporting its context window is full has described the
-- TRANSCRIPT, not the task. The autonomous path checkpoints that transcript
-- after every tool call (persistAutonomousSession), so by the time the run ends
-- the saturated conversation is already persisted — and the next delivery of the
-- same trigger resumes into a window that cannot fit it. That run fails, writes
-- nothing, and leaves the same artifact in place, so every later run on that
-- trigger fails identically with nothing in the data saying why.
--
-- The chat path can guard its single write; this one has to undo one. This
-- column is that undo, recorded rather than inferred: an operator looking at a
-- trigger that suddenly started from scratch can see it was abandoned, which
-- session it was, and (from the log line that accompanies it) what the run said.
--
-- A flag rather than a DELETE on purpose. The artifact is the evidence, and
-- discarding it would leave a gap with no explanation. The 7-day expires_at TTL
-- already reaps the row on its own schedule.
--
-- Read side: loadRunSession adds `retired_session_id IS DISTINCT FROM
-- sdk_session_id`, so a retired row is skipped and the run starts fresh.
-- Write side: saveRunSession's upsert resets the column to NULL, because a new
-- artifact is a new conversation and the old abandonment does not apply to it —
-- without that reset the very next session would be skipped as if it were the
-- saturated one and the trigger could never resume again.

ALTER TABLE agent_run_sessions
  ADD COLUMN IF NOT EXISTS retired_session_id TEXT;

COMMENT ON COLUMN agent_run_sessions.retired_session_id IS
  'When equal to sdk_session_id, this session was abandoned and must not be resumed: the run that produced it ended by reporting an exhausted context window, so resuming would reproduce that failure on every later run of this trigger. Set by retireRunSession (agent-execution/autonomous-session.ts) at run completion, detected by contextExhaustedCompletion (agent-execution/resume-safety.ts). Reset to NULL by the saveRunSession upsert, since a new artifact is a new conversation. NULL for every row that was never abandoned.';
