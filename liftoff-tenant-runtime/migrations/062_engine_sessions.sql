-- Engine Sessions table for SDK session persistence across Cloud Tasks invocations.
-- Stores full JSONL session data for restore-to-disk pattern on stateless Cloud Run.
-- 24-hour default TTL. 10MB max session data.

CREATE TABLE IF NOT EXISTS engine_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  session_ref TEXT NOT NULL,
  session_data TEXT NOT NULL DEFAULT '' CHECK (length(session_data) <= 10485760),
  engine_type TEXT NOT NULL,
  pause_reason TEXT NOT NULL,
  approval_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_engine_sessions_invocation ON engine_sessions(invocation_id);
CREATE INDEX IF NOT EXISTS idx_engine_sessions_expires ON engine_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_engine_sessions_tenant ON engine_sessions(tenant_id, expires_at);
