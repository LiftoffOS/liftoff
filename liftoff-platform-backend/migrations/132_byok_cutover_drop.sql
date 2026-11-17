-- Migration 132: Drop legacy BYOK/Claude Code Proxy tables from platform-backend post-cutover.
-- Prerequisites: liftoff-developer-proxy live and routing all /proxy/* and /api/claude-code/* traffic.
-- Applied automatically by node-pg-migrate on next platform-backend-migrate execution.
--
-- llm_usage_log is RETAINED — platform-backend still logs its own LLM calls
-- (insights chat, internal-agent distill, agent chat). Only the proxy-specific
-- columns (proxy_key_id, proxy_account_id) are removed; these referenced
-- claude_code_proxy_keys which is being dropped.

BEGIN;

-- Drop pricing table first (no dependents).
DROP TABLE IF EXISTS claude_code_model_pricing CASCADE;

-- Drop proxy keys table (proxy_key_id FK on llm_usage_log must go first).
ALTER TABLE llm_usage_log DROP COLUMN IF EXISTS proxy_key_id;
ALTER TABLE llm_usage_log DROP COLUMN IF EXISTS proxy_account_id;
DROP TABLE IF EXISTS claude_code_proxy_keys CASCADE;

COMMIT;
