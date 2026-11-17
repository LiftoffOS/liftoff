-- Add agent_id and session_id to llm_usage_log for per-agent cost attribution.
-- session_id links pre-creation LLM calls (distill) to the agent created afterward.
-- After agent creation, backfill: UPDATE llm_usage_log SET agent_id = $1 WHERE session_id = $2

ALTER TABLE llm_usage_log ADD COLUMN agent_id TEXT;
ALTER TABLE llm_usage_log ADD COLUMN session_id TEXT;

CREATE INDEX idx_llm_usage_log_agent ON llm_usage_log (tenant_id, agent_id, timestamp)
  WHERE agent_id IS NOT NULL;
CREATE INDEX idx_llm_usage_log_session ON llm_usage_log (session_id)
  WHERE session_id IS NOT NULL;
