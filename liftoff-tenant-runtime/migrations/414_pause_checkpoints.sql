-- 414: the canonical transcript, checkpointed WITH the pause.
--
-- A paused run is resumed from a transcript. Today that transcript is one of
-- two things, and neither is bound to the pause:
--
--   * the flattened `conversationHistory` snapshot on the pause payload, which
--     reaches the model as prose; or
--   * the canonical copy saveCanonicalArtifact writes onto the session tables
--     (chat_sessions / agent_run_sessions). That write is an UPDATE onto a row
--     the native artifact owns, so an engine that produces no native session
--     (Codex, opencode, the Gemini CLI) has no row for it to hit, and the row
--     it does hit is keyed by a thread or trigger that many pauses share, so
--     the bytes may be an earlier turn's. Nothing on the pause says which.
--
-- This table gives the checkpoint its own row, keyed by the PAUSE: one row per
-- pause, inserted before the pause row is written and awaited, so a pause that
-- exists either carries a checkpoint or says why it does not. The pause payload
-- carries `checkpoint: { id, sha256, messageCount }` and the resume loads the
-- row named by the pause it is resuming, verifying tenant, agent, sha and the
-- paused invocation. Freshness is by construction rather than by inference.
--
--   pause_id                 the agent_scheduled_invocations.id (or the
--                            wake_wait_sets.id for a wait-set) the pause row is
--                            about to get. Minted by the pause creator before
--                            either row is written. No FK: the two tables are
--                            written in that order, and a checkpoint whose pause
--                            never landed simply expires.
--   invocation_id            the invocation that paused, as the pause row
--                            records it in scheduled_by_invocation_id; the
--                            resume refuses a checkpoint for any other.
--   execution_engine         the engine that PRODUCED the record. A cross-engine
--                            resume needs the source to know what to strip.
--   canonical_content        the CanonicalTrajectory `messages` array, as the
--                            recorder accumulated it up to the pause.
--   canonical_schema_version the schema the messages were shaped under, so a
--                            reader can decline a version it predates.
--   canonical_sha256         sha256 over the order-independent serialization
--                            (canonicalSerialize), the same discipline as the
--                            session tables' canonical_sha256: jsonb sorts keys.
--   message_count            how many messages the record held at the pause.
--   expires_at               7 days, with the pause, the same window
--                            agent_run_sessions.expires_at keeps.
--
-- The session tables and saveCanonicalArtifact stay as they are for the
-- cross-engine resume they serve today. This is the copy a PAUSE resumes from.

CREATE TABLE IF NOT EXISTS pause_checkpoints (
  tenant_id                UUID        NOT NULL,
  pause_id                 UUID        NOT NULL,
  invocation_id            TEXT,
  agent_id                 UUID        NOT NULL,
  execution_engine         TEXT        NOT NULL,
  provider                 TEXT        NOT NULL,
  model                    TEXT        NOT NULL,
  canonical_content        JSONB       NOT NULL,
  canonical_schema_version TEXT        NOT NULL,
  canonical_sha256         TEXT        NOT NULL,
  message_count            INTEGER     NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  PRIMARY KEY (tenant_id, pause_id)
);

-- Sweeper-friendly, as agent_run_sessions' expiry index is: a sweep reads by
-- age, and the resume path filters on expires_at > NOW().
CREATE INDEX IF NOT EXISTS idx_pause_checkpoints_expiry
  ON pause_checkpoints (expires_at);

-- Tenant-scoped, so tenant-scoped rows. This runtime serves every tenant in its
-- database (ADR-011); a table with a tenant_id and no policy is one forgotten
-- WHERE clause away from another customer's transcript. FORCE so the table
-- owner is bound too.
ALTER TABLE pause_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE pause_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY pause_checkpoints_tenant ON pause_checkpoints
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE pause_checkpoints IS
  'The canonical conversation (src/trajectories/types.ts messages) at the moment a run paused, one row per pause, keyed by the pause row it belongs to. Written before the pause row and awaited; the pause payload carries the id, sha256 and message count, and the resume verifies all three plus the paused invocation before replaying it. Expires with the pause.';
COMMENT ON COLUMN pause_checkpoints.pause_id IS
  'The agent_scheduled_invocations.id (wake_wait_sets.id for a wait-set) the pause row was minted with. Not a foreign key: the checkpoint is written first, and one whose pause never landed expires on its own.';
COMMENT ON COLUMN pause_checkpoints.canonical_sha256 IS
  'sha256 over canonicalSerialize(canonical_content). The pause payload carries the same value; a resume that finds them different declines the row and replays the payload snapshot instead.';
