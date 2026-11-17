-- §4.10 Part C: autonomous crash-resume — persist the SDK session for autonomous
-- runs the same way chat_sessions does for chat, so a Cloud Tasks retry / Pub/Sub
-- redelivery resumes the exact conversation (resumeSessionId) instead of restarting
-- from scratch. Keyed (trigger_key, agent_id) — the stable trigger identity.
--
-- Gated behind AUTONOMOUS_RESUME_ENABLED at runtime. 7-day TTL.
-- Renumber on merge if 303 is taken upstream.

CREATE TABLE IF NOT EXISTS agent_run_sessions (
    trigger_key    TEXT NOT NULL,
    agent_id       UUID NOT NULL,
    sdk_session_id TEXT NOT NULL,
    jsonl_content  TEXT NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (trigger_key, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_sessions_expiry
  ON agent_run_sessions (expires_at);
