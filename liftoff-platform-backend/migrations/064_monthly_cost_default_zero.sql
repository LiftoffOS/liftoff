-- Migration: Set monthly_cost default to 0
-- The monthly_cost column is no longer populated with mock data at creation time.
-- Real cost is computed on read from tenant runtime invocation data.

ALTER TABLE internal_agents ALTER COLUMN monthly_cost SET DEFAULT 0;
