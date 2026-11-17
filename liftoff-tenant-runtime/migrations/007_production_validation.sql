-- Production Validation Tables
-- Per Section 21: Validation rig - run design-partner workflows end to end

CREATE TABLE IF NOT EXISTS production_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  design_partner_id VARCHAR(255) NOT NULL,
  design_partner_name VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, running, passed, failed, skipped
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  phases JSONB NOT NULL DEFAULT '[]',
  summary JSONB NOT NULL DEFAULT '{}',
  connector_tests JSONB NOT NULL DEFAULT '[]',
  real_data_tests JSONB NOT NULL DEFAULT '[]',
  config JSONB NOT NULL DEFAULT '{}',
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for production validations
CREATE INDEX IF NOT EXISTS idx_validations_tenant ON production_validations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_validations_partner ON production_validations(design_partner_id);
CREATE INDEX IF NOT EXISTS idx_validations_status ON production_validations(status);
CREATE INDEX IF NOT EXISTS idx_validations_created ON production_validations(created_at DESC);

-- Design partner configurations
CREATE TABLE IF NOT EXISTS design_partners (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  tenant_id VARCHAR(255) NOT NULL,
  contact_email VARCHAR(255),
  connectors JSONB NOT NULL DEFAULT '[]',
  test_workflows JSONB NOT NULL DEFAULT '[]',
  validation_criteria JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(50) NOT NULL DEFAULT 'onboarding', -- onboarding, active, validated, churned
  last_validation_id UUID REFERENCES production_validations(id),
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for design partners
CREATE INDEX IF NOT EXISTS idx_design_partners_tenant ON design_partners(tenant_id);
CREATE INDEX IF NOT EXISTS idx_design_partners_status ON design_partners(status);

-- Instruction previews (for preview/approval phase verification)
CREATE TABLE IF NOT EXISTS instruction_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  instruction_version_id UUID,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  summary TEXT,
  systems_accessed JSONB NOT NULL DEFAULT '[]',
  systems_written_to JSONB NOT NULL DEFAULT '[]',
  example_scenarios JSONB NOT NULL DEFAULT '[]',
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for instruction previews
CREATE INDEX IF NOT EXISTS idx_instruction_previews_tenant ON instruction_previews(tenant_id);
CREATE INDEX IF NOT EXISTS idx_instruction_previews_status ON instruction_previews(status);

-- NOTE: compensation_plans table is already defined in 003_missing_tables.sql

-- Reflection runs (for reflection phase verification)
CREATE TABLE IF NOT EXISTS reflection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(255) NOT NULL,
  agent_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, running, completed, failed
  trigger_type VARCHAR(50) NOT NULL, -- n_successful_runs, periodic, manual
  suggestions JSONB NOT NULL DEFAULT '[]',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for reflection runs
CREATE INDEX IF NOT EXISTS idx_reflection_runs_tenant ON reflection_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_reflection_runs_agent ON reflection_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_reflection_runs_status ON reflection_runs(status);

-- Function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_validation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER trigger_validations_updated_at
  BEFORE UPDATE ON production_validations
  FOR EACH ROW EXECUTE FUNCTION update_validation_updated_at();

CREATE TRIGGER trigger_partners_updated_at
  BEFORE UPDATE ON design_partners
  FOR EACH ROW EXECUTE FUNCTION update_validation_updated_at();

CREATE TRIGGER trigger_previews_updated_at
  BEFORE UPDATE ON instruction_previews
  FOR EACH ROW EXECUTE FUNCTION update_validation_updated_at();

-- NOTE: View moved to 007b_production_validation_view.sql to ensure tables are committed first
