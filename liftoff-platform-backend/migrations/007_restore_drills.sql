-- Restore Drill Tables
-- Per Section 17: Quarterly restore drill automation

CREATE TABLE IF NOT EXISTS restore_drills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drill_type VARCHAR(50) NOT NULL, -- full, point_in_time, table_level
  environment VARCHAR(50) NOT NULL, -- staging, development (never production)
  source_backup_id VARCHAR(255) NOT NULL,
  source_timestamp TIMESTAMPTZ NOT NULL,
  target_database VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'scheduled', -- scheduled, running, verifying, completed, failed
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration INTEGER, -- seconds
  results JSONB NOT NULL DEFAULT '{}',
  verification_checks JSONB NOT NULL DEFAULT '[]',
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Ensure drills never run against production
  CONSTRAINT no_production_drills CHECK (environment IN ('staging', 'development'))
);

-- Indexes for restore drills
CREATE INDEX IF NOT EXISTS idx_restore_drills_environment ON restore_drills(environment);
CREATE INDEX IF NOT EXISTS idx_restore_drills_status ON restore_drills(status);
CREATE INDEX IF NOT EXISTS idx_restore_drills_completed ON restore_drills(completed_at DESC) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS idx_restore_drills_created ON restore_drills(created_at DESC);

-- RTO/RPO Tier Documentation Table
CREATE TABLE IF NOT EXISTS rto_rpo_tiers (
  tier VARCHAR(50) PRIMARY KEY,
  description TEXT NOT NULL,
  rto_minutes INTEGER NOT NULL,
  rpo_minutes INTEGER NOT NULL,
  backup_frequency VARCHAR(50) NOT NULL,
  retention_days INTEGER NOT NULL,
  services TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert RTO/RPO tier documentation
INSERT INTO rto_rpo_tiers (tier, description, rto_minutes, rpo_minutes, backup_frequency, retention_days, services)
VALUES
  ('critical', 'Mission-critical services that directly impact customer workflows', 15, 5, 'continuous (PITR)', 35, ARRAY['coordinator', 'action-ledger', 'tool-gateway']),
  ('high', 'Core platform services required for normal operation', 60, 15, 'hourly', 30, ARRAY['tenant-api', 'instruction-compiler', 'usage-ledger']),
  ('medium', 'Supporting services that can tolerate brief outages', 240, 60, 'daily', 14, ARRAY['reflection-engine', 'connector-service', 'notification-service']),
  ('low', 'Non-critical services, reports, and analytics', 1440, 1440, 'daily', 7, ARRAY['reporting', 'analytics', 'audit-export'])
ON CONFLICT (tier) DO UPDATE SET
  description = EXCLUDED.description,
  rto_minutes = EXCLUDED.rto_minutes,
  rpo_minutes = EXCLUDED.rpo_minutes,
  backup_frequency = EXCLUDED.backup_frequency,
  retention_days = EXCLUDED.retention_days,
  services = EXCLUDED.services,
  updated_at = NOW();

-- Function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_restore_drills_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for updated_at
CREATE TRIGGER trigger_restore_drills_updated_at
  BEFORE UPDATE ON restore_drills
  FOR EACH ROW EXECUTE FUNCTION update_restore_drills_updated_at();

-- View for drill summary
CREATE OR REPLACE VIEW restore_drill_summary AS
SELECT
  environment,
  COUNT(*) as total_drills,
  COUNT(*) FILTER (WHERE status = 'completed') as successful_drills,
  COUNT(*) FILTER (WHERE status = 'failed') as failed_drills,
  MAX(completed_at) FILTER (WHERE status = 'completed') as last_successful_drill,
  AVG(duration) FILTER (WHERE status = 'completed') as avg_duration_seconds,
  AVG((results->>'actualRtoMinutes')::numeric) FILTER (WHERE status = 'completed') as avg_rto_minutes,
  AVG((results->>'actualRpoMinutes')::numeric) FILTER (WHERE status = 'completed') as avg_rpo_minutes
FROM restore_drills
GROUP BY environment;
