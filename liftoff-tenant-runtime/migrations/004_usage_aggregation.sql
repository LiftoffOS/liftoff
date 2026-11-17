-- Usage Aggregation Tables
-- Usage aggregation, forecast snapshots, operator visibility

-- Usage snapshots for aggregated usage data
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  period VARCHAR(20) NOT NULL, -- hourly, daily, weekly, monthly
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  total_credits DECIMAL(18, 4) NOT NULL DEFAULT 0,
  total_actions INTEGER NOT NULL DEFAULT 0,
  by_event_type JSONB NOT NULL DEFAULT '{}',
  by_agent JSONB NOT NULL DEFAULT '{}',
  by_connector JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, period, period_start)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_tenant_period
  ON usage_snapshots(tenant_id, period, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_usage_snapshots_period_start
  ON usage_snapshots(period_start DESC);

-- Forecast snapshots for usage predictions
CREATE TABLE IF NOT EXISTS forecast_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  forecast_date TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL, -- End of billing period being forecasted
  projected_credits DECIMAL(18, 4) NOT NULL,
  projected_actions INTEGER NOT NULL DEFAULT 0,
  confidence_interval JSONB NOT NULL DEFAULT '{"low": 0, "high": 0}',
  trend VARCHAR(20) NOT NULL, -- increasing, stable, decreasing
  trend_percentage DECIMAL(10, 2) NOT NULL DEFAULT 0,
  alerts JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for forecast queries
CREATE INDEX IF NOT EXISTS idx_forecast_snapshots_tenant_date
  ON forecast_snapshots(tenant_id, forecast_date DESC);

-- Aggregation jobs for tracking aggregation runs
CREATE TABLE IF NOT EXISTS aggregation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  period VARCHAR(20) NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, running, completed, failed
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Index for finding pending jobs
CREATE INDEX IF NOT EXISTS idx_aggregation_jobs_status
  ON aggregation_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_aggregation_jobs_tenant
  ON aggregation_jobs(tenant_id, created_at DESC);

-- Add created_at to usage_events if not exists (for aggregation queries)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'usage_events' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE usage_events ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX idx_usage_events_created_at ON usage_events(created_at);
  END IF;
END $$;

-- Add index for aggregation queries on usage_events
CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_created
  ON usage_events(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_agent_created
  ON usage_events(tenant_id, agent_id, created_at);
