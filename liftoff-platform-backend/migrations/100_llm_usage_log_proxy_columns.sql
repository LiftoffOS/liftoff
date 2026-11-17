-- Add proxy attribution and cache token columns to llm_usage_log
-- Dedicated proxy columns avoid overloading session_id/agent_id which have
-- established semantics (distill sessions, internal agent IDs).

-- Cache token tracking — needed for accurate cost estimation
ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS cache_creation_input_tokens INTEGER DEFAULT 0;
ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS cache_read_input_tokens INTEGER DEFAULT 0;

-- Dedicated proxy attribution columns
ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS proxy_key_id UUID;
ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS proxy_account_id UUID;

-- Index for proxy usage queries (per-tenant, per-key, per-member)
CREATE INDEX IF NOT EXISTS idx_llm_usage_log_proxy
  ON llm_usage_log (tenant_id, proxy_key_id, timestamp)
  WHERE proxy_key_id IS NOT NULL;
