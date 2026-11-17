-- Migration 011: Rollout Health Monitoring
-- Per Section 17: Continuous health monitoring for progressive rollouts

-- Request metrics for rollouts (used for health checking)
CREATE TABLE IF NOT EXISTS rollout_request_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rollout_id UUID NOT NULL REFERENCES model_rollouts(id),
    tenant_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(255),
    success BOOLEAN NOT NULL,
    latency_ms NUMERIC NOT NULL,
    error_code VARCHAR(50),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_rollout_request_metrics_rollout ON rollout_request_metrics(rollout_id);
CREATE INDEX IF NOT EXISTS idx_rollout_request_metrics_time ON rollout_request_metrics(rollout_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rollout_request_metrics_cleanup ON rollout_request_metrics(created_at);

-- Add last_health_check_at column to model_rollouts
ALTER TABLE model_rollouts ADD COLUMN IF NOT EXISTS last_health_check_at TIMESTAMP WITH TIME ZONE;

-- Partitioning setup for metrics (for high-volume environments)
-- This is a reference for future partitioning if needed:
-- CREATE TABLE rollout_request_metrics_partitioned (
--     id UUID DEFAULT gen_random_uuid(),
--     rollout_id UUID NOT NULL,
--     ...
--     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
-- ) PARTITION BY RANGE (created_at);

-- Automatic cleanup function (keep 24 hours of metrics)
CREATE OR REPLACE FUNCTION cleanup_old_rollout_metrics() RETURNS void AS $$
BEGIN
    DELETE FROM rollout_request_metrics
    WHERE created_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- Comments
COMMENT ON TABLE rollout_request_metrics IS 'Request-level metrics for rollout health monitoring';
COMMENT ON COLUMN model_rollouts.last_health_check_at IS 'Last time health metrics were evaluated for this rollout';
