-- 292_delegation_spawn_pause
-- Cluster-wide and per-tenant kill switch for the delegate_task fan-out.
-- Populated by an operator via INSERT. Polled
-- by every delegateToAgents call before opening the fan-out.

CREATE TABLE IF NOT EXISTS delegation_spawn_pause (
  scope text PRIMARY KEY,    -- 'global' or `tenant:${tenantId}`
  paused_at timestamptz NOT NULL DEFAULT NOW(),
  paused_by text
);
