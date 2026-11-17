-- WS-6.4 — feed query indexes for /api/usage-ledger/feed.
--
-- NO-OP: the indexes this migration originally tried to create are already
-- created in migration 004_usage_aggregation.sql:
--   - idx_usage_events_created_at         on (created_at)
--   - idx_usage_events_tenant_created     on (tenant_id, created_at)
--   - idx_usage_events_tenant_agent_created on (tenant_id, agent_id, created_at)
--
-- The earlier version of this file referenced a non-existent table
-- (`usage_ledger_events`) and a non-existent column (`occurred_at`). The
-- actual feed query in src/usage-ledger/router.ts is:
--   SELECT ... FROM usage_events WHERE created_at > $1 ORDER BY created_at ASC
-- which the existing idx_usage_events_created_at index serves directly.
--
-- Keeping the file (and the pgmigrations row) so the historical migration
-- order is unbroken — deleting it would skip 240 forever on existing envs
-- (TR migrate runs with --no-check-order, but a missing file confuses
-- replay tools and audits).

SELECT 1;
