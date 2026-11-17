CREATE TABLE web_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  caller_session_id TEXT NOT NULL,
  vendor TEXT NOT NULL CHECK (vendor IN ('webclaw','anchor','browserbase')),
  vendor_session_id TEXT,
  vendor_metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '1 hour',
  closed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, agent_id, caller_session_id)
);

CREATE INDEX idx_web_sessions_expiry ON web_sessions (expires_at) WHERE closed_at IS NULL;
