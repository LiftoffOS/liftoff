-- Add thread_id and invocation_id to llm_usage_log so secondary platform-backend
-- LLM calls (title generation, context absorption, rolling summary) can be attributed
-- to the specific chat session that triggered them, not just the agent.
ALTER TABLE llm_usage_log
  ADD COLUMN IF NOT EXISTS thread_id TEXT,
  ADD COLUMN IF NOT EXISTS invocation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_llm_usage_log_thread ON llm_usage_log (thread_id)
  WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_llm_usage_log_invocation ON llm_usage_log (invocation_id)
  WHERE invocation_id IS NOT NULL;

-- Add thread_id to cost_attribution_events so the unified cost view can answer
-- "what did this specific chat session cost?" for interactive workloads.
ALTER TABLE cost_attribution_events
  ADD COLUMN IF NOT EXISTS thread_id TEXT,
  ADD COLUMN IF NOT EXISTS parent_invocation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_cae_thread ON cost_attribution_events (tenant_id, thread_id)
  WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cae_parent_invocation ON cost_attribution_events (parent_invocation_id)
  WHERE parent_invocation_id IS NOT NULL;
