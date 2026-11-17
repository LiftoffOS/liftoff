-- 365: reflection quotas that reset themselves, and a weekly cap that is
-- actually per agent.
--
-- 1. QUOTA WINDOWS. `resetDailyQuotas` and `resetWeeklyQuotas` depend on a
--    scheduled caller, and `last_reset_at` is only a creation stamp. Without
--    that caller the counters are monotonic: once a workspace reaches 10 daily
--    or 5 weekly it is blocked from reflecting indefinitely.
--
--    The fix is a WINDOW rather than another scheduled job. A job that resets
--    a counter is one more thing that can be missing. Storing when each
--    window opened lets the read path roll it forward on its own, so a quota
--    is correct whether or not anything ran.
--
-- 2. "WEEKLY AGENT RUNS" IS PER AGENT. `incrementWeeklyAgentRunsUsed` takes
--    an agentId, but a column on `reflection_quotas` is keyed by tenant, so a
--    workspace with seven agents would share five reflections per week between
--    all of them. Per-agent is what the name, the parameter and the intent all
--    describe, and it needs per-agent storage.
--
-- `daily_runs_used` and `current_concurrent_jobs` stay on the tenant row:
-- those genuinely are workspace-wide (spend rate, and in-flight jobs).

ALTER TABLE reflection_quotas
  ADD COLUMN IF NOT EXISTS daily_window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Existing rows carry a last_reset_at that was only ever a creation stamp;
-- seed the window from it so the first read rolls forward correctly rather
-- than treating a week-old row as brand new.
UPDATE reflection_quotas
   SET daily_window_started_at = COALESCE(last_reset_at, NOW())
 WHERE daily_window_started_at IS NULL
    OR daily_window_started_at > COALESCE(last_reset_at, NOW());

-- Per-agent weekly counter. Keyed by agent because that is what it counts.
CREATE TABLE IF NOT EXISTS reflection_agent_quotas (
  tenant_id          UUID        NOT NULL,
  agent_id           UUID        NOT NULL,
  weekly_runs_used   INTEGER     NOT NULL DEFAULT 0,
  -- When the current seven-day window opened. The read path rolls it forward,
  -- so no scheduled job is required for the counter to be correct.
  window_started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id)
);

CREATE INDEX IF NOT EXISTS idx_reflection_agent_quotas_tenant
  ON reflection_agent_quotas (tenant_id);

-- The tenant-level weekly column is left in place but is no longer read or
-- written. Dropping it in the same migration that starts using its
-- replacement would make a rollback lossy, and the value it holds is the
-- workspace-wide count this table replaces.
COMMENT ON COLUMN reflection_quotas.weekly_agent_runs_used IS
  'Deprecated; use reflection_agent_quotas.weekly_runs_used. Workspace-wide '
  'count, no longer read or written.';
