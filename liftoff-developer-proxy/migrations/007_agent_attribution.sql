-- Add agent attribution columns to byok_usage_log.
-- agent_id, action_id, invocation_id are populated from forwarded request
-- headers (x-agent-id, x-action-id, x-invocation-id) set by the caller.
ALTER TABLE byok_usage_log
  ADD COLUMN agent_id TEXT,
  ADD COLUMN action_id TEXT,
  ADD COLUMN invocation_id TEXT;

CREATE INDEX idx_byok_usage_agent
  ON byok_usage_log (tenant_id, agent_id, started_at)
  WHERE agent_id IS NOT NULL;
