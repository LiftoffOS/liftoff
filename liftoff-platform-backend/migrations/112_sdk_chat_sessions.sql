-- SDK-backed interactive chat: session persistence + per-tenant feature flag

CREATE TABLE IF NOT EXISTS agent_chat_sessions (
  thread_id UUID NOT NULL REFERENCES agent_chat_threads(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  session_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent ON agent_chat_sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_expires ON agent_chat_sessions (expires_at);

-- Per-tenant feature flag for SDK chat mode
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS chat_sdk_mode VARCHAR(10) DEFAULT 'legacy'
  CHECK (chat_sdk_mode IN ('legacy', 'sdk'));
