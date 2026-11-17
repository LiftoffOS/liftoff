-- Immutable log of every LLM API call made by the tenant runtime.
-- One row per llmClient.complete() invocation — success or failure.
-- This is the single source of truth for token consumption.

CREATE TABLE IF NOT EXISTS llm_usage_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  success       BOOLEAN NOT NULL,
  error_message TEXT,
  -- Attribution context (populated by caller)
  tenant_id     TEXT,
  agent_id      TEXT,
  invocation_id TEXT,
  purpose       TEXT  -- e.g. 'agent_execution', 'reflection', 'research'
);

-- Query patterns: per-tenant aggregation, per-model breakdown, failed-call auditing
CREATE INDEX idx_llm_usage_log_tenant_ts ON llm_usage_log (tenant_id, timestamp);
CREATE INDEX idx_llm_usage_log_success ON llm_usage_log (success) WHERE success = false;
