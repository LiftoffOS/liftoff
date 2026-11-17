-- 324_agent_run_sessions_artifact_binding
-- Same native-session-artifact binding as 323, for the autonomous crash-resume
-- table (agent_run_sessions, keyed by trigger_key). It stores the same Claude
-- Agent SDK project JSONL and had the same problem: no engine/format/version
-- ownership and no integrity checksum, so autonomous-session restore
-- (autonomous-session.ts) loaded the bytes without validating who produced them.
--
-- Add the same typed envelope columns so the resume path validates ownership,
-- format, version, and integrity before restoring.

ALTER TABLE agent_run_sessions
  ADD COLUMN IF NOT EXISTS execution_engine         TEXT,
  ADD COLUMN IF NOT EXISTS artifact_format          TEXT,
  ADD COLUMN IF NOT EXISTS artifact_format_version  INTEGER,
  ADD COLUMN IF NOT EXISTS producer_runtime_version TEXT,
  ADD COLUMN IF NOT EXISTS artifact_sha256          TEXT;

-- Backfill: every existing row is Claude Agent SDK JSONL. See 323 for the
-- rationale (owned as claude-agent-sdk; legacy sha256 NULL; 7-day TTL).
UPDATE agent_run_sessions
   SET execution_engine        = 'claude-agent-sdk',
       artifact_format         = 'claude-project-jsonl',
       artifact_format_version = 1
 WHERE execution_engine IS NULL;
