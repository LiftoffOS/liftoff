-- 323_chat_sessions_artifact_binding
-- Bind the persisted session artifact to the engine that produced it.
--
-- Until now chat_sessions held raw Claude Agent SDK project JSONL with no record
-- of WHICH engine, artifact format, format version, or runtime produced the
-- bytes, and no integrity checksum. A resume that restores those bytes therefore
-- could not tell whether the current deployment's engine is even compatible —
-- a flag/provider change could feed one engine's native state to another.
--
-- Add typed ownership + a Liftoff-owned artifact-format version (distinct from
-- the producing SDK version) + a sha256 integrity checksum, so the resume path
-- can validate ownership/format/version/integrity BEFORE restoring
-- (session-artifact-envelope.ts). Ownership is persisted, never inferred from the
-- live provider/flags.

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS execution_engine         TEXT,
  ADD COLUMN IF NOT EXISTS artifact_format          TEXT,
  ADD COLUMN IF NOT EXISTS artifact_format_version  INTEGER,
  ADD COLUMN IF NOT EXISTS producer_runtime_version TEXT,
  ADD COLUMN IF NOT EXISTS artifact_sha256          TEXT;

-- Backfill existing rows: every byte in this table today is Claude Agent SDK
-- project JSONL (the only engine that externalizes a session here). Mark them
-- owned so the resume validator treats them as claude-agent-sdk rather than
-- whatever the live deployment currently resolves. producer_runtime_version and
-- artifact_sha256 stay NULL for these legacy rows (the validator allows a NULL
-- checksum as legacy-unverified); the 7-day TTL ages them out within a week, and
-- new rows carry the full envelope (incl. sha256) written by the app.
UPDATE chat_sessions
   SET execution_engine        = 'claude-agent-sdk',
       artifact_format         = 'claude-project-jsonl',
       artifact_format_version = 1
 WHERE execution_engine IS NULL;
