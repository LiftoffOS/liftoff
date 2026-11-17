-- Migration 012: Usage Aggregation Tables
-- Per Section 14: Control plane aggregates usage from tenant runtimes

-- Usage records from tenant runtimes
CREATE TABLE IF NOT EXISTS usage_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(255) NOT NULL,
    meter_name VARCHAR(255) NOT NULL,
    value NUMERIC NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    agent_id UUID,
    workflow_id UUID,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_usage_records_tenant ON usage_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_meter ON usage_records(meter_name);
CREATE INDEX IF NOT EXISTS idx_usage_records_timestamp ON usage_records(tenant_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_records_aggregation ON usage_records(tenant_id, meter_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_records_cleanup ON usage_records(timestamp);

-- Usage snapshots for billing periods
CREATE TABLE IF NOT EXISTS usage_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(255) NOT NULL,
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    meters JSONB NOT NULL,
    reported_to_stripe BOOLEAN NOT NULL DEFAULT false,
    reported_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for snapshots
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_tenant ON usage_snapshots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_period ON usage_snapshots(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_unreported ON usage_snapshots(reported_to_stripe) WHERE reported_to_stripe = false;

-- Unique constraint to prevent duplicate snapshots
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_snapshots_unique
    ON usage_snapshots(tenant_id, period_start, period_end);

-- Comments
COMMENT ON TABLE usage_records IS 'Raw usage records from tenant runtimes';
COMMENT ON TABLE usage_snapshots IS 'Aggregated usage snapshots for billing';
COMMENT ON COLUMN usage_snapshots.meters IS 'Map of meter names to total values for the period';
