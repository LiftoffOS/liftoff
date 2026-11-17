-- Compliance Evidence Tables
-- Per Section 19/20: SOC 2 and GDPR readiness - compliance evidence collection

-- Evidence Records
CREATE TABLE IF NOT EXISTS compliance_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL, -- access_review, change_management, audit_log, security_scan, etc.
  framework VARCHAR(20) NOT NULL, -- SOC2, GDPR, HIPAA, ISO27001, PCI_DSS
  control_id VARCHAR(20) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, collected, reviewed, approved, expired
  collected_by VARCHAR(255) NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by VARCHAR(255),
  reviewed_at TIMESTAMPTZ,
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  artifact_path TEXT,
  artifact_hash VARCHAR(64), -- SHA-256 hash for integrity
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for evidence
CREATE INDEX IF NOT EXISTS idx_evidence_framework ON compliance_evidence(framework);
CREATE INDEX IF NOT EXISTS idx_evidence_control ON compliance_evidence(control_id);
CREATE INDEX IF NOT EXISTS idx_evidence_status ON compliance_evidence(status);
CREATE INDEX IF NOT EXISTS idx_evidence_collected ON compliance_evidence(collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_expires ON compliance_evidence(expires_at) WHERE expires_at IS NOT NULL;

-- Access Review Reports
CREATE TABLE IF NOT EXISTS access_review_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_period_start TIMESTAMPTZ NOT NULL,
  review_period_end TIMESTAMPTZ NOT NULL,
  reviewed_by VARCHAR(255) NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_users INTEGER NOT NULL,
  users_reviewed INTEGER NOT NULL,
  access_changes JSONB NOT NULL DEFAULT '[]',
  findings JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress', -- in_progress, completed, approved
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for access review reports
CREATE INDEX IF NOT EXISTS idx_access_reviews_period ON access_review_reports(review_period_start, review_period_end);

-- Change Management Records
CREATE TABLE IF NOT EXISTS change_management_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_type VARCHAR(50) NOT NULL, -- code, infrastructure, configuration, access, policy
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  requested_by VARCHAR(255) NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  implemented_by VARCHAR(255),
  implemented_at TIMESTAMPTZ,
  environment VARCHAR(50) NOT NULL, -- development, staging, production
  risk_level VARCHAR(20) NOT NULL, -- high, medium, low
  rollback_plan TEXT,
  test_evidence TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'requested', -- requested, approved, implemented, verified, rejected, rolled_back
  verified_by VARCHAR(255),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for change management
CREATE INDEX IF NOT EXISTS idx_changes_status ON change_management_records(status);
CREATE INDEX IF NOT EXISTS idx_changes_environment ON change_management_records(environment);
CREATE INDEX IF NOT EXISTS idx_changes_requested ON change_management_records(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_risk ON change_management_records(risk_level, status);

-- Change Artifacts
CREATE TABLE IF NOT EXISTS change_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id UUID NOT NULL REFERENCES change_management_records(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- commit, pr, ticket, test_result, approval_email, deployment_log
  reference VARCHAR(255) NOT NULL,
  url TEXT,
  hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for change artifacts
CREATE INDEX IF NOT EXISTS idx_artifacts_change ON change_artifacts(change_id);

-- Audit Packages
CREATE TABLE IF NOT EXISTS audit_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  framework VARCHAR(20) NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  generated_by VARCHAR(255) NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft, review, final
  controls JSONB NOT NULL DEFAULT '[]',
  summary JSONB NOT NULL DEFAULT '{}',
  artifact_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for audit packages
CREATE INDEX IF NOT EXISTS idx_audit_packages_framework ON audit_packages(framework);
CREATE INDEX IF NOT EXISTS idx_audit_packages_period ON audit_packages(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_audit_packages_status ON audit_packages(status);

-- Function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_compliance_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER trigger_evidence_updated_at
  BEFORE UPDATE ON compliance_evidence
  FOR EACH ROW EXECUTE FUNCTION update_compliance_updated_at();

CREATE TRIGGER trigger_changes_updated_at
  BEFORE UPDATE ON change_management_records
  FOR EACH ROW EXECUTE FUNCTION update_compliance_updated_at();
