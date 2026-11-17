-- Per Section 13: Entitlement snapshots for billing disputes
-- Captures entitlement state at points in time for audit and dispute resolution

CREATE TABLE entitlement_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  entitlement_id UUID NOT NULL REFERENCES entitlements(id),
  entitlement_version INTEGER NOT NULL,

  -- Snapshot of entitlement state
  tenant_operational_status VARCHAR(20) NOT NULL,
  agent_execution_allowed BOOLEAN NOT NULL,
  remaining_included_credits NUMERIC(12, 2) NOT NULL,
  overage_allowed BOOLEAN NOT NULL,
  max_active_agents INTEGER NOT NULL,
  max_active_workflows INTEGER NOT NULL,
  max_actions_per_minute INTEGER NOT NULL,
  max_reflection_runs_per_day INTEGER NOT NULL,
  max_queued_tasks INTEGER NOT NULL,
  max_connector_writes_per_minute INTEGER NOT NULL,
  db_concurrency_budget INTEGER NOT NULL,
  included_monthly_credits NUMERIC(12, 2) NOT NULL,
  overage_ceiling NUMERIC(12, 2) NOT NULL,
  max_reflection_runs_per_week INTEGER NOT NULL,

  -- Snapshot metadata
  snapshot_reason VARCHAR(30) NOT NULL CHECK (
    snapshot_reason IN ('periodic', 'billing_cycle', 'entitlement_change', 'dispute_request')
  ),
  billing_period_start TIMESTAMP,
  billing_period_end TIMESTAMP,
  snapshot_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_entitlement_snapshots_tenant_time
  ON entitlement_snapshots(tenant_id, snapshot_at DESC);

CREATE INDEX idx_entitlement_snapshots_billing_period
  ON entitlement_snapshots(tenant_id, billing_period_start, billing_period_end);

CREATE INDEX idx_entitlement_snapshots_reason
  ON entitlement_snapshots(snapshot_reason, created_at DESC);

-- Comment for documentation
COMMENT ON TABLE entitlement_snapshots IS
  'Entitlement snapshots for billing disputes and audit';
