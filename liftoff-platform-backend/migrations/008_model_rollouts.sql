-- Model Rollouts Migration
-- Per Section 17: Rollout approval workflow for model/prompt changes

-- Model Rollouts Table
CREATE TABLE IF NOT EXISTS model_rollouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  model_id UUID NOT NULL REFERENCES models(id),
  previous_model_id UUID REFERENCES models(id),
  version INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  strategy VARCHAR(50) NOT NULL DEFAULT 'immediate',
  config JSONB NOT NULL DEFAULT '{}',

  -- Approval tracking
  requested_by VARCHAR(255) NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  rejected_by VARCHAR(255),
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,

  -- Rollout progress
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  rollbacked_at TIMESTAMPTZ,
  rollback_reason TEXT,

  -- Progressive rollout tracking
  current_step INTEGER DEFAULT 0,
  current_percentage INTEGER DEFAULT 0,
  next_step_at TIMESTAMPTZ,

  -- Metrics
  metrics JSONB NOT NULL DEFAULT '{"requestsTotal":0,"requestsSuccess":0,"requestsFailed":0,"averageLatencyMs":0,"p99LatencyMs":0,"errorRate":0}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT valid_status CHECK (status IN ('pending', 'approved', 'rejected', 'in_progress', 'completed', 'rolled_back')),
  CONSTRAINT valid_strategy CHECK (strategy IN ('immediate', 'canary', 'gradual', 'blue_green'))
);

-- Indexes for model rollouts
CREATE INDEX IF NOT EXISTS idx_model_rollouts_tenant ON model_rollouts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_model_rollouts_status ON model_rollouts(status);
CREATE INDEX IF NOT EXISTS idx_model_rollouts_pending ON model_rollouts(tenant_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_model_rollouts_in_progress ON model_rollouts(status, next_step_at) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_model_rollouts_created ON model_rollouts(created_at DESC);

-- Rollout Audit Log for tracking all state changes
CREATE TABLE IF NOT EXISTS rollout_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rollout_id UUID NOT NULL REFERENCES model_rollouts(id),
  action VARCHAR(100) NOT NULL,
  actor VARCHAR(255) NOT NULL,
  previous_status VARCHAR(50),
  new_status VARCHAR(50),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rollout_audit_rollout ON rollout_audit_log(rollout_id);
CREATE INDEX IF NOT EXISTS idx_rollout_audit_created ON rollout_audit_log(created_at DESC);

-- Rollout Notifications Table for tracking sent notifications
CREATE TABLE IF NOT EXISTS rollout_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rollout_id UUID NOT NULL REFERENCES model_rollouts(id),
  notification_type VARCHAR(100) NOT NULL,
  recipient VARCHAR(255) NOT NULL,
  channel VARCHAR(50) NOT NULL DEFAULT 'email',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_rollout_notifications_rollout ON rollout_notifications(rollout_id);

-- Traffic Split Rules for gradual rollouts
CREATE TABLE IF NOT EXISTS rollout_traffic_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rollout_id UUID NOT NULL REFERENCES model_rollouts(id),
  percentage INTEGER NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_traffic_splits_rollout ON rollout_traffic_splits(rollout_id);
CREATE INDEX IF NOT EXISTS idx_traffic_splits_active ON rollout_traffic_splits(rollout_id, is_active) WHERE is_active = true;

-- Function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_model_rollouts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trigger_model_rollouts_updated_at ON model_rollouts;
CREATE TRIGGER trigger_model_rollouts_updated_at
  BEFORE UPDATE ON model_rollouts
  FOR EACH ROW EXECUTE FUNCTION update_model_rollouts_updated_at();

-- View for active rollouts with model info
CREATE OR REPLACE VIEW active_rollouts AS
SELECT
  r.id,
  r.tenant_id,
  r.model_id,
  m.name as model_name,
  m.provider,
  r.previous_model_id,
  pm.name as previous_model_name,
  r.status,
  r.strategy,
  r.current_step,
  r.current_percentage,
  r.next_step_at,
  r.config,
  r.metrics,
  r.requested_by,
  r.requested_at,
  r.approved_by,
  r.approved_at,
  r.started_at
FROM model_rollouts r
JOIN models m ON r.model_id = m.id
LEFT JOIN models pm ON r.previous_model_id = pm.id
WHERE r.status IN ('pending', 'approved', 'in_progress');

-- ==========================================
-- Prompt Bundle Rollouts
-- ==========================================

-- Prompt Bundle Rollouts Table
CREATE TABLE IF NOT EXISTS prompt_rollouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  bundle_id UUID NOT NULL REFERENCES prompt_bundles(id),
  previous_bundle_id UUID REFERENCES prompt_bundles(id),
  version INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  strategy VARCHAR(50) NOT NULL DEFAULT 'immediate',
  config JSONB NOT NULL DEFAULT '{}',

  -- Approval tracking
  requested_by VARCHAR(255) NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  rejected_by VARCHAR(255),
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,

  -- Rollout progress
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  rollbacked_at TIMESTAMPTZ,
  rollback_reason TEXT,

  -- Progressive rollout tracking
  current_step INTEGER DEFAULT 0,
  current_percentage INTEGER DEFAULT 0,
  next_step_at TIMESTAMPTZ,

  -- Metrics
  metrics JSONB NOT NULL DEFAULT '{"requestsTotal":0,"requestsSuccess":0,"requestsFailed":0,"averageLatencyMs":0,"p99LatencyMs":0,"errorRate":0}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT prompt_valid_status CHECK (status IN ('pending', 'approved', 'rejected', 'in_progress', 'completed', 'rolled_back')),
  CONSTRAINT prompt_valid_strategy CHECK (strategy IN ('immediate', 'canary', 'gradual', 'blue_green'))
);

-- Indexes for prompt rollouts
CREATE INDEX IF NOT EXISTS idx_prompt_rollouts_tenant ON prompt_rollouts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_prompt_rollouts_status ON prompt_rollouts(status);
CREATE INDEX IF NOT EXISTS idx_prompt_rollouts_pending ON prompt_rollouts(tenant_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_prompt_rollouts_in_progress ON prompt_rollouts(status, next_step_at) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS idx_prompt_rollouts_created ON prompt_rollouts(created_at DESC);

-- Prompt Rollout Audit Log
CREATE TABLE IF NOT EXISTS prompt_rollout_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rollout_id UUID NOT NULL REFERENCES prompt_rollouts(id),
  action VARCHAR(100) NOT NULL,
  actor VARCHAR(255) NOT NULL,
  previous_status VARCHAR(50),
  new_status VARCHAR(50),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_rollout_audit_rollout ON prompt_rollout_audit_log(rollout_id);

-- Prompt Rollout Traffic Splits
CREATE TABLE IF NOT EXISTS prompt_rollout_traffic_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rollout_id UUID NOT NULL REFERENCES prompt_rollouts(id),
  percentage INTEGER NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prompt_traffic_splits_active ON prompt_rollout_traffic_splits(rollout_id, is_active) WHERE is_active = true;

-- Function to auto-update prompt rollouts
CREATE OR REPLACE FUNCTION update_prompt_rollouts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_prompt_rollouts_updated_at ON prompt_rollouts;
CREATE TRIGGER trigger_prompt_rollouts_updated_at
  BEFORE UPDATE ON prompt_rollouts
  FOR EACH ROW EXECUTE FUNCTION update_prompt_rollouts_updated_at();

-- View for active prompt rollouts
CREATE OR REPLACE VIEW active_prompt_rollouts AS
SELECT
  r.id,
  r.tenant_id,
  r.bundle_id,
  pb.name as bundle_name,
  pb.version as bundle_version,
  r.previous_bundle_id,
  ppb.name as previous_bundle_name,
  r.status,
  r.strategy,
  r.current_step,
  r.current_percentage,
  r.next_step_at,
  r.config,
  r.metrics,
  r.requested_by,
  r.requested_at,
  r.approved_by,
  r.approved_at,
  r.started_at
FROM prompt_rollouts r
JOIN prompt_bundles pb ON r.bundle_id = pb.id
LEFT JOIN prompt_bundles ppb ON r.previous_bundle_id = ppb.id
WHERE r.status IN ('pending', 'approved', 'in_progress');

-- Combined view of all pending approvals
CREATE OR REPLACE VIEW pending_approvals AS
SELECT
  'model' as rollout_type,
  mr.id,
  mr.tenant_id,
  m.name as target_name,
  mr.strategy,
  mr.requested_by,
  mr.requested_at,
  mr.config
FROM model_rollouts mr
JOIN models m ON mr.model_id = m.id
WHERE mr.status = 'pending'
UNION ALL
SELECT
  'prompt' as rollout_type,
  pr.id,
  pr.tenant_id,
  pb.name as target_name,
  pr.strategy,
  pr.requested_by,
  pr.requested_at,
  pr.config
FROM prompt_rollouts pr
JOIN prompt_bundles pb ON pr.bundle_id = pb.id
WHERE pr.status = 'pending'
ORDER BY requested_at ASC;
