-- 326_session_artifact_binding_constraints
-- Enforce the native-session-artifact envelope at the DATABASE, not just in app
-- code: every durable artifact must carry its owning engine + format + Liftoff
-- format-version so a corrupt/partial write can never masquerade as an unbound
-- (implicitly-claude) row.
--
-- Defensive backfill first (any row an overlap-window revision might have written
-- before the envelope shipped), then NOT NULL on the identity columns + bounded
-- CHECKs. producer_runtime_version + artifact_sha256 stay nullable (legacy rows
-- predate them; new writes always set them). Neither table is RLS-forced. The
-- CHECKs are NOT VALID — they bind all NEW writes without a blocking full-table
-- validation (mirrors 321/322).

-- chat_sessions ------------------------------------------------------------
UPDATE chat_sessions
   SET execution_engine        = COALESCE(execution_engine, 'claude-agent-sdk'),
       artifact_format         = COALESCE(artifact_format, 'claude-project-jsonl'),
       artifact_format_version = COALESCE(artifact_format_version, 1)
 WHERE execution_engine IS NULL OR artifact_format IS NULL OR artifact_format_version IS NULL;

ALTER TABLE chat_sessions
  ALTER COLUMN execution_engine        SET NOT NULL,
  ALTER COLUMN artifact_format         SET NOT NULL,
  ALTER COLUMN artifact_format_version SET NOT NULL;

ALTER TABLE chat_sessions
  ADD CONSTRAINT chk_chat_sessions_execution_engine
    CHECK (execution_engine = ANY (ARRAY['claude-agent-sdk','openai-agents','openai-codex','google-genai','google-adk','openrouter-openai-wire','opencode','unknown-legacy'])) NOT VALID,
  ADD CONSTRAINT chk_chat_sessions_artifact_format_version
    CHECK (artifact_format_version >= 1) NOT VALID;

-- agent_run_sessions -------------------------------------------------------
UPDATE agent_run_sessions
   SET execution_engine        = COALESCE(execution_engine, 'claude-agent-sdk'),
       artifact_format         = COALESCE(artifact_format, 'claude-project-jsonl'),
       artifact_format_version = COALESCE(artifact_format_version, 1)
 WHERE execution_engine IS NULL OR artifact_format IS NULL OR artifact_format_version IS NULL;

ALTER TABLE agent_run_sessions
  ALTER COLUMN execution_engine        SET NOT NULL,
  ALTER COLUMN artifact_format         SET NOT NULL,
  ALTER COLUMN artifact_format_version SET NOT NULL;

ALTER TABLE agent_run_sessions
  ADD CONSTRAINT chk_agent_run_sessions_execution_engine
    CHECK (execution_engine = ANY (ARRAY['claude-agent-sdk','openai-agents','openai-codex','google-genai','google-adk','openrouter-openai-wire','opencode','unknown-legacy'])) NOT VALID,
  ADD CONSTRAINT chk_agent_run_sessions_artifact_format_version
    CHECK (artifact_format_version >= 1) NOT VALID;
