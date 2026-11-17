-- Quota Enforcement Tables
-- Stronger quota enforcement

-- Rate limit buckets for token bucket algorithm
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  bucket_type VARCHAR(50) NOT NULL, -- actions, workflows, connector_writes, api_requests
  resource_id VARCHAR(255), -- Optional: agentId, connectorId, etc.
  tokens DECIMAL(10, 4) NOT NULL DEFAULT 0,
  last_refill_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, bucket_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_tenant
  ON rate_limit_buckets(tenant_id);

-- Rate limit configurations (for tenant-specific overrides)
CREATE TABLE IF NOT EXISTS rate_limit_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  bucket_type VARCHAR(50) NOT NULL,
  capacity INTEGER NOT NULL,
  refill_rate INTEGER NOT NULL, -- Tokens per second
  refill_interval_ms INTEGER NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(tenant_id, bucket_type)
);

-- Effective quotas (base + adjustments)
CREATE TABLE IF NOT EXISTS effective_quotas (
  tenant_id VARCHAR(255) PRIMARY KEY,
  max_active_agents INTEGER,
  max_active_workflows INTEGER,
  max_queued_tasks INTEGER,
  max_actions_per_minute INTEGER,
  max_connector_writes_per_minute INTEGER,
  db_concurrency_budget INTEGER,
  included_monthly_credits INTEGER,
  overage_ceiling INTEGER,
  max_reflection_runs_per_day INTEGER,
  max_reflection_runs_per_week INTEGER,
  expires_at TIMESTAMPTZ, -- When adjustments expire
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quota adjustments history
CREATE TABLE IF NOT EXISTS quota_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  quota_type VARCHAR(50) NOT NULL,
  previous_value INTEGER NOT NULL,
  new_value INTEGER NOT NULL,
  reason VARCHAR(50) NOT NULL, -- high_load, low_load, plan_upgrade, plan_downgrade, abuse_detected, manual_override, scheduled
  expires_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by VARCHAR(255) NOT NULL,
  reverted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_quota_adjustments_tenant
  ON quota_adjustments(tenant_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_quota_adjustments_expires
  ON quota_adjustments(expires_at)
  WHERE expires_at IS NOT NULL AND reverted_at IS NULL;

-- Tenant metrics for load-based adjustments
CREATE TABLE IF NOT EXISTS tenant_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actions_per_minute INTEGER NOT NULL DEFAULT 0,
  active_workflows INTEGER NOT NULL DEFAULT 0,
  queue_depth INTEGER NOT NULL DEFAULT 0,
  error_rate DECIMAL(5, 4) NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tenant_metrics_tenant_time
  ON tenant_metrics(tenant_id, recorded_at DESC);

-- Partition by time for efficient cleanup
-- In production, consider using native partitioning:
-- CREATE TABLE tenant_metrics (...) PARTITION BY RANGE (recorded_at);

-- Connector auth attempts for abuse detection
CREATE TABLE IF NOT EXISTS connector_auth_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  connector VARCHAR(100) NOT NULL,
  success BOOLEAN NOT NULL,
  error_code VARCHAR(50),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connector_auth_attempts_tenant
  ON connector_auth_attempts(tenant_id, attempted_at DESC);

-- Cleanup old metrics (keep 24 hours)
CREATE OR REPLACE FUNCTION cleanup_old_metrics()
RETURNS void AS $$
BEGIN
  DELETE FROM tenant_metrics WHERE recorded_at < NOW() - INTERVAL '24 hours';
  DELETE FROM connector_auth_attempts WHERE attempted_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- Schedule cleanup (run via Cloud Scheduler or pg_cron)
-- SELECT cron.schedule('cleanup_metrics', '0 * * * *', 'SELECT cleanup_old_metrics()');
