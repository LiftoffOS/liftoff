-- 294_chat_sessions
-- TR owns the Claude Agent SDK's per-thread session state end-to-end.
--
-- WHY this exists (not just what it stores):
-- The SDK persists conversation state as JSONL files at
-- `~/.claude/projects/<project_dir>/<session_id>.jsonl`. That file is
-- WHAT `query({ resume: <session_id> })` reads to continue a conversation
-- — system prompt cache keys, compaction boundaries, message UUIDs, the
-- full transcript. Designed for local-fs deploys where the same process
-- handles every turn.
--
-- We run TR on Cloud Run with maxScale=10 and no session affinity. A
-- second turn for the same thread may land on ANY warm instance, where
-- the prior JSONL file does not exist. The SDK then errors with
-- "No conversation found with session ID: <id>" and the conversation
-- can no longer resume — degrading to a cold start that loses the SDK's
-- internal continuity (prompt cache keys, compaction state) even though
-- our DB-replay still rebuilds the message history.
--
-- This table externalizes the JSONL transcript so any TR instance can
-- restore it to local disk before invoking the SDK. The flow per turn:
--   1. Load row by (thread_id, agent_id) — get sdk_session_id + jsonl
--   2. Write jsonl to <HOME>/.claude/projects/<project_dir>/<sdk_session_id>.jsonl
--   3. Invoke SDK with query({ resume: sdk_session_id, cwd: <pinned cwd> })
--      — SDK reads the JSONL we just wrote, resumes cleanly on ANY instance
--   4. After completion, read the file (SDK appended this turn's messages)
--   5. Upsert the updated jsonl back into this table
--
-- PB's agent_chat_sessions table stores the canonical (thread, agent) →
-- sdk_session_id pointer for cross-instance continuity tracking; this
-- table holds the actual transcript bytes that make resume work.

CREATE TABLE IF NOT EXISTS chat_sessions (
  thread_id      UUID         NOT NULL,
  agent_id       UUID         NOT NULL,
  sdk_session_id TEXT         NOT NULL,
  jsonl_content  TEXT         NOT NULL,
  expires_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, agent_id)
);

-- Sweeper-friendly: a future cron / chat-turn-side eviction can read
-- ORDER BY expires_at and drop stale rows in batches.
CREATE INDEX IF NOT EXISTS idx_chat_sessions_expires
  ON chat_sessions (expires_at);
