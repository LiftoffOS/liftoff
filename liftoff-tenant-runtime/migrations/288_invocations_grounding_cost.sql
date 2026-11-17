-- Google Search grounding is billed per query ($0.014/query), separate from
-- model tokens and NOT derivable from them (unlike token cost, which is derived
-- on read from tokens × price snapshots). Persist the per-invocation grounding
-- query count and the cost charged so the billing-queued reconciliation job can
-- reconstruct the full cost (token cost + grounding) when the real-time
-- invocation.completed publish failed. Without these, a reconciliation retry
-- recomputes cost from tokens only and silently undercharges grounding.
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS grounding_queries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS grounding_cost_usd NUMERIC(18,9) NOT NULL DEFAULT 0;
