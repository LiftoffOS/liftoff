-- Migration 097: Per-tenant resource metering for cost attribution
-- Phase 4: Tracks resource usage per tenant per hour for shared-tier billing
--
-- Partitioned by period_start (monthly) for efficient queries and retention.
-- Dedicated tenants don't need metering — GCP billing export gives per-project costs.

CREATE TABLE IF NOT EXISTS tenant_resource_usage (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  quantity BIGINT NOT NULL DEFAULT 0,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Partitioned tables require partition key in PK and UNIQUE constraints.
  -- FK REFERENCES not supported on partitioned tables — enforced by application.
  PRIMARY KEY (id, period_start),
  UNIQUE (tenant_id, period_start, resource_type)
) PARTITION BY RANGE (period_start);

-- Create partitions for current and next month
CREATE TABLE IF NOT EXISTS tenant_resource_usage_2026_04 PARTITION OF tenant_resource_usage
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS tenant_resource_usage_2026_05 PARTITION OF tenant_resource_usage
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS tenant_resource_usage_2026_06 PARTITION OF tenant_resource_usage
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Index for tenant-period lookups and aggregation
CREATE INDEX IF NOT EXISTS idx_resource_usage_tenant_period
  ON tenant_resource_usage(tenant_id, period_start);

-- Index for resource-type aggregation (e.g., "sum all Cloud Run usage this month")
CREATE INDEX IF NOT EXISTS idx_resource_usage_type_period
  ON tenant_resource_usage(resource_type, period_start);

-- RLS: tenant_id column present, RLS policy will be applied by migration 095's dynamic DO block.
-- Since 097 runs after 095, we manually enable RLS here for the new table.
ALTER TABLE tenant_resource_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_resource_usage ON tenant_resource_usage;
CREATE POLICY tenant_isolation_tenant_resource_usage ON tenant_resource_usage
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Cost allocation table: monthly reconciliation of metered usage to GCP costs
CREATE TABLE IF NOT EXISTS tenant_cost_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  billing_month DATE NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  metered_quantity BIGINT NOT NULL DEFAULT 0,
  metered_duration_ms BIGINT NOT NULL DEFAULT 0,
  allocated_cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  total_platform_cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  allocation_percentage NUMERIC(5, 4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, billing_month, resource_type)
);

CREATE INDEX IF NOT EXISTS idx_cost_allocations_tenant_month
  ON tenant_cost_allocations(tenant_id, billing_month);

-- RLS on cost allocations
ALTER TABLE tenant_cost_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_cost_allocations ON tenant_cost_allocations;
CREATE POLICY tenant_isolation_tenant_cost_allocations ON tenant_cost_allocations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
