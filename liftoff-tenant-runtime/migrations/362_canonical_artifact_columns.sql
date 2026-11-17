-- 362: canonical conversation alongside the native session artifact.
--
-- Today chat_sessions and agent_run_sessions hold ONE engine's native artifact
-- (Claude Agent SDK project JSONL) and nothing else. That has a consequence
-- decideArtifactResume states plainly: when the persisted artifact is owned by a
-- different engine the verdict is `fallback`, and `fallback` means START A FRESH
-- SESSION. The conversation is not migrated; it is discarded. A tenant whose
-- agent moves between engines — a provider switch, an engine flag flip, a model
-- change that resolves differently — loses the thread, with no error and nothing
-- in the data recording that it happened.
--
-- These columns hold the vendor-neutral copy of the same conversation. It is
-- accumulated per invocation by src/trajectories/recorder.ts (which already runs
-- for every engine, through six per-vendor mappers) and written at the same
-- checkpoints that already persist the native artifact. The native artifact
-- stays the fast path and is unchanged; this is what makes a cross-engine resume
-- possible at all rather than a cold start.
--
--   canonical_content        — the CanonicalTrajectory `messages` array, JSONB.
--   canonical_schema_version — the canonical schema the rows were written under,
--                              so a reader can refuse a version it predates
--                              instead of misreading it.
--   canonical_sha256         — integrity, mirroring artifact_sha256's role for
--                              the native payload.
--
-- All three are nullable with no backfill: rows written before this migration
-- have no canonical copy and must keep behaving exactly as they do now (native
-- resume, or a cold start). A NULL here means "no canonical copy", never "empty
-- conversation" — the read path distinguishes them.
--
-- Both tables are already FORCE RLS; adding columns does not change their
-- policies, and the census in migrations/__tests__/200_verification.integration
-- .test.ts still covers them unchanged.

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS canonical_content        jsonb,
  ADD COLUMN IF NOT EXISTS canonical_schema_version text,
  ADD COLUMN IF NOT EXISTS canonical_sha256         text;

ALTER TABLE agent_run_sessions
  ADD COLUMN IF NOT EXISTS canonical_content        jsonb,
  ADD COLUMN IF NOT EXISTS canonical_schema_version text,
  ADD COLUMN IF NOT EXISTS canonical_sha256         text;

COMMENT ON COLUMN chat_sessions.canonical_content IS
  'Vendor-neutral copy of this session''s conversation: the CanonicalTrajectory `messages` array (src/trajectories/types.ts), accumulated by the per-invocation recorder and written by saveCanonicalArtifact. Read when decideArtifactResume returns `fallback` — an artifact owned by another engine — so the conversation can be rebuilt on the resuming engine instead of discarded. NULL means no canonical copy was captured (pre-migration rows, or a run whose recorder produced nothing); it never means the conversation was empty.';
COMMENT ON COLUMN chat_sessions.canonical_schema_version IS
  'The CanonicalTrajectory schema_version canonical_content was written under. A reader that does not support the recorded version must decline the row rather than interpret it under the wrong schema.';
COMMENT ON COLUMN chat_sessions.canonical_sha256 IS
  'sha256 of the serialized canonical_content at write time. Same role artifact_sha256 plays for the native payload: a mismatch on read is corruption, and the row must not be restored.';

COMMENT ON COLUMN agent_run_sessions.canonical_content IS
  'Vendor-neutral copy of this trigger''s conversation: the CanonicalTrajectory `messages` array (src/trajectories/types.ts), accumulated by the per-invocation recorder and written by saveCanonicalArtifact at the same checkpoints that persist jsonl_content. Read when decideArtifactResume returns `fallback` — an artifact owned by another engine — so the conversation can be rebuilt on the resuming engine instead of discarded. NULL means no canonical copy was captured; it never means the conversation was empty.';
COMMENT ON COLUMN agent_run_sessions.canonical_schema_version IS
  'The CanonicalTrajectory schema_version canonical_content was written under. A reader that does not support the recorded version must decline the row rather than interpret it under the wrong schema.';
COMMENT ON COLUMN agent_run_sessions.canonical_sha256 IS
  'sha256 of the serialized canonical_content at write time. Same role artifact_sha256 plays for the native payload: a mismatch on read is corruption, and the row must not be restored.';
