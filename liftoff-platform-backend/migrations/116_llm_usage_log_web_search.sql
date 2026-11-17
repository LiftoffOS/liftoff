-- Phase 6: track Anthropic server-side tool usage (web search) on
-- llm_usage_log so we can charge CAIO for web-search requests ($10 per
-- 1000 requests as of the 2026-04 pricing). Existing rows keep 0 — no
-- web-search history was ever recorded.

ALTER TABLE llm_usage_log
  ADD COLUMN IF NOT EXISTS web_search_requests INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_llm_usage_log_web_search
  ON llm_usage_log (tenant_id, timestamp)
  WHERE web_search_requests > 0;
