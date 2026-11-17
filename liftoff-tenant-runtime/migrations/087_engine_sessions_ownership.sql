-- engine_sessions ownership columns
-- Adds tenant_id + thread_id + agent_id to engine_sessions so session resume
-- validates the full tuple (addresses session-prediction risk from R3).

ALTER TABLE engine_sessions
  ADD COLUMN IF NOT EXISTS tenant_id UUID,
  ADD COLUMN IF NOT EXISTS thread_id UUID,
  ADD COLUMN IF NOT EXISTS agent_id UUID;

CREATE INDEX IF NOT EXISTS idx_engine_sessions_ownership
  ON engine_sessions (tenant_id, thread_id, agent_id);

COMMENT ON COLUMN engine_sessions.tenant_id IS 'Session ownership enforcement';
COMMENT ON COLUMN engine_sessions.thread_id IS 'Session ownership enforcement';
COMMENT ON COLUMN engine_sessions.agent_id IS 'Session ownership enforcement';
