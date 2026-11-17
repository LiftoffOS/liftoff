-- 290_tenant_runtime_config
-- Per-tenant runtime knobs read by:
--   • delegateToAgents (Part 5) for fanout / depth / concurrency caps
--   • registerTrajectoryRecorder (Part 6) for the sink-enabled + max-bytes
--     + nested-code-session gates
-- Operator-only writes via psql Cloud Run Job; no admin endpoint. Manual
-- Pub/Sub publish after each UPSERT invalidates the in-memory LRU on each
-- tenant-runtime instance (see src/events/tenant-runtime-config-subscriber.ts).

CREATE TABLE IF NOT EXISTS tenant_runtime_config (
  tenant_id text PRIMARY KEY,

  -- Part 5: delegation overrides (NULL → use DELEGATION_DEFAULTS)
  max_delegation_depth int,
  max_delegation_fanout int,
  default_max_concurrent_children int,
  max_hitl_before_interrupt int,
  reawait_in_flight_deadline_ms int,        -- §C3 reawaitInFlightDelegations cap

  -- Part 6: trajectory sink controls.
  -- Collect-first by default. Tenant opts out by flipping this to false via
  -- the operator SQL UPSERT pattern documented in the plan's Write Path
  -- section.
  trajectory_sink_enabled boolean NOT NULL DEFAULT true,
  trajectory_sink_max_bytes bigint,
  trajectory_capture_nested_code_sessions boolean NOT NULL DEFAULT false,

  -- Audit + versioning
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  updated_by text
);

-- Hard caps live in code (DELEGATION_HARD_CAPS); the table stores soft
-- preferences subject to clamp. A NULL row value means "use the in-code
-- default".

-- Row-level security (matches existing pattern at migration 079)
ALTER TABLE tenant_runtime_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_runtime_config_isolation ON tenant_runtime_config
  FOR ALL TO PUBLIC
  USING (tenant_id = current_setting('app.tenant_id', true));
