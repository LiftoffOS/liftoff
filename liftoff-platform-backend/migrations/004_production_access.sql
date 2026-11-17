-- Production Access Workflow Tables
-- Per Section 19: SOC 2 and GDPR readiness - production-access workflow

-- Access Requests (requires approval)
CREATE TABLE IF NOT EXISTS production_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id VARCHAR(255) NOT NULL,
  requester_email VARCHAR(255) NOT NULL,
  access_level VARCHAR(50) NOT NULL, -- read, write, admin, breakglass
  reason VARCHAR(50) NOT NULL, -- incident, maintenance, investigation, deployment, other
  justification TEXT NOT NULL,
  target_resources JSONB NOT NULL DEFAULT '[]',
  target_environment VARCHAR(50) NOT NULL, -- staging, production
  duration_minutes INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, approved, denied, expired, revoked, active
  approver_id VARCHAR(255),
  approver_email VARCHAR(255),
  approved_at TIMESTAMPTZ,
  denial_reason TEXT,
  granted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by VARCHAR(255),
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for access requests
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON production_access_requests(status);
CREATE INDEX IF NOT EXISTS idx_access_requests_requester ON production_access_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_access_requests_environment ON production_access_requests(target_environment, status);
CREATE INDEX IF NOT EXISTS idx_access_requests_expires ON production_access_requests(expires_at) WHERE status = 'active';

-- Breakglass Requests (immediate access for incidents)
CREATE TABLE IF NOT EXISTS breakglass_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id VARCHAR(255) NOT NULL,
  requester_email VARCHAR(255) NOT NULL,
  incident_id VARCHAR(255) NOT NULL,
  incident_severity VARCHAR(10) NOT NULL, -- P1, P2, P3, P4
  target_resources JSONB NOT NULL DEFAULT '[]',
  target_environment VARCHAR(50) NOT NULL,
  justification TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'active', -- active, expired, revoked
  granted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by VARCHAR(255),
  revoked_reason TEXT,
  post_incident_review_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for breakglass requests
CREATE INDEX IF NOT EXISTS idx_breakglass_status ON breakglass_requests(status);
CREATE INDEX IF NOT EXISTS idx_breakglass_incident ON breakglass_requests(incident_id);
CREATE INDEX IF NOT EXISTS idx_breakglass_expires ON breakglass_requests(expires_at) WHERE status = 'active';

-- Breakglass Actions (audit trail of actions during breakglass)
CREATE TABLE IF NOT EXISTS breakglass_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  breakglass_id UUID NOT NULL REFERENCES breakglass_requests(id),
  action_type VARCHAR(100) NOT NULL,
  target_resource TEXT NOT NULL,
  action_details JSONB NOT NULL DEFAULT '{}',
  performed_at TIMESTAMPTZ NOT NULL,
  performed_by VARCHAR(255) NOT NULL
);

-- Index for breakglass actions
CREATE INDEX IF NOT EXISTS idx_breakglass_actions_breakglass ON breakglass_actions(breakglass_id);

-- Production Access Audit Trail
CREATE TABLE IF NOT EXISTS production_access_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(50) NOT NULL,
  request_id UUID REFERENCES production_access_requests(id),
  breakglass_id UUID REFERENCES breakglass_requests(id),
  user_id VARCHAR(255) NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  target_resources JSONB NOT NULL DEFAULT '[]',
  target_environment VARCHAR(50) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  ip_address VARCHAR(45),
  user_agent TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for audit trail
CREATE INDEX IF NOT EXISTS idx_access_audit_user ON production_access_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_request ON production_access_audit(request_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_breakglass ON production_access_audit(breakglass_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_timestamp ON production_access_audit(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_access_audit_event_type ON production_access_audit(event_type, timestamp DESC);

-- Approval Gates (configurable approval policies)
CREATE TABLE IF NOT EXISTS approval_gates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  required_approvers INTEGER NOT NULL DEFAULT 1,
  approver_roles TEXT[] NOT NULL DEFAULT '{}',
  auto_expire_minutes INTEGER NOT NULL DEFAULT 60,
  requires_mfa BOOLEAN NOT NULL DEFAULT true,
  requires_justification BOOLEAN NOT NULL DEFAULT true,
  allowed_access_levels TEXT[] NOT NULL DEFAULT '{}',
  allowed_reasons TEXT[] NOT NULL DEFAULT '{}',
  target_environments TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default approval gates
INSERT INTO approval_gates (name, description, required_approvers, approver_roles, auto_expire_minutes, requires_mfa, requires_justification, allowed_access_levels, allowed_reasons, target_environments)
VALUES
  ('production-read', 'Read-only production access', 1, ARRAY['security', 'platform-admin'], 60, true, true, ARRAY['read'], ARRAY['incident', 'investigation', 'maintenance'], ARRAY['production']),
  ('production-write', 'Write access to production', 2, ARRAY['security', 'platform-admin'], 120, true, true, ARRAY['write'], ARRAY['incident', 'maintenance', 'deployment'], ARRAY['production']),
  ('production-admin', 'Admin access to production', 2, ARRAY['security-lead', 'cto'], 30, true, true, ARRAY['admin'], ARRAY['incident'], ARRAY['production']),
  ('staging-all', 'All access levels for staging', 1, ARRAY['developer', 'security', 'platform-admin'], 240, false, true, ARRAY['read', 'write', 'admin'], ARRAY['incident', 'maintenance', 'investigation', 'deployment', 'other'], ARRAY['staging'])
ON CONFLICT (name) DO NOTHING;

-- Function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_production_access_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER trigger_access_requests_updated_at
  BEFORE UPDATE ON production_access_requests
  FOR EACH ROW EXECUTE FUNCTION update_production_access_updated_at();

CREATE TRIGGER trigger_breakglass_updated_at
  BEFORE UPDATE ON breakglass_requests
  FOR EACH ROW EXECUTE FUNCTION update_production_access_updated_at();

CREATE TRIGGER trigger_approval_gates_updated_at
  BEFORE UPDATE ON approval_gates
  FOR EACH ROW EXECUTE FUNCTION update_production_access_updated_at();
