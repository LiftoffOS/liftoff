-- Migration 374: agent_performance_snapshots rate columns admit NULL = "unknown".
--
-- `autonomy_rate DECIMAL NOT NULL DEFAULT 0` (migration 065) forced every
-- snapshot to assert a number. The autonomy figure is not always knowable — an
-- agent with no finished runs in the window has no rate — and 0 is not the
-- honest stand-in for that: on a metric where higher is better, 0 reads as
-- COMPLETE dependence on a person, which is a positive claim the data does not
-- make.
--
-- Worse, the write path could not even express the alternative. Binding NULL
-- against a NOT NULL column raises, `savePerformanceSnapshot` does no null
-- handling, and the weekly cron catches per agent and logs a warning — so the
-- agents whose autonomy is unknown would have silently stopped getting snapshots
-- entirely, which is exactly the population the figure is about.
--
-- The sibling rate columns are relaxed in the same change. This does not
-- change a single stored value; it removes the
-- schema-level claim that every one of these numbers is always knowable, so the
-- next one that is not can say so instead of being rounded to a lie.
--
-- Idempotent: DROP NOT NULL on a column that already admits NULL is a no-op.
-- The DEFAULT 0 is deliberately LEFT IN PLACE — an INSERT that omits the column
-- keeps behaving exactly as before; only an INSERT that explicitly binds NULL
-- gains new behaviour.

ALTER TABLE agent_performance_snapshots ALTER COLUMN autonomy_rate   DROP NOT NULL;
ALTER TABLE agent_performance_snapshots ALTER COLUMN success_rate    DROP NOT NULL;
ALTER TABLE agent_performance_snapshots ALTER COLUMN escalation_rate DROP NOT NULL;
ALTER TABLE agent_performance_snapshots ALTER COLUMN correction_rate DROP NOT NULL;

COMMENT ON COLUMN agent_performance_snapshots.autonomy_rate IS
  'Share of finished tasks in the window that never stopped for a person (hitl_approval or ask_user pause). NULL = unknown (no finished runs in the window); it is NOT zero. Sandbox connector approvals carry no invocation and are outside this per-task rate by construction.';
