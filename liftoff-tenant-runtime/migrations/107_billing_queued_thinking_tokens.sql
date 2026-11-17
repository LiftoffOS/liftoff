-- Billing pipeline prerequisites
--
-- 1. thinking_tokens / tool_use_tokens / turns on llm_usage_log
--    Thinking tokens are billed at output rate (Anthropic extended-thinking).
--    Stored separately so cost attribution can apply the correct multiplier.
--
-- 2. billing_queued on invocations
--    Tracks whether the invocation.completed Pub/Sub event has been published.
--    'pending'   = event not yet published (default; also set on publish failure)
--    'published' = event published; spend-subscriber has received it
--    'processed' = billing confirmed receipt (set by reconciliation cron)
--    The reconciliation cron queries WHERE billing_queued = 'pending' AND
--    ended_at < NOW() - INTERVAL '5 minutes' to detect silent publish failures.

ALTER TABLE llm_usage_log
  ADD COLUMN IF NOT EXISTS thinking_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tool_use_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS turns           INTEGER NOT NULL DEFAULT 1;

ALTER TABLE invocations
  ADD COLUMN IF NOT EXISTS billing_queued TEXT NOT NULL DEFAULT 'pending'
    CHECK (billing_queued IN ('pending', 'published', 'processed'));

-- Sparse index: only pending rows need to be found by the reconciliation cron.
CREATE INDEX IF NOT EXISTS idx_invocations_billing_queued
  ON invocations (billing_queued, completed_at)
  WHERE billing_queued = 'pending';
