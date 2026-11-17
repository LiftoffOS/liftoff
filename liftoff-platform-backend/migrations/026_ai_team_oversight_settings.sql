-- AI Team Oversight Settings
-- Per implementation plan: Phase 1 HITL Enforcement
-- Stores tenant-level oversight configuration with version tracking for audit trail

-- Oversight settings with version tracking (security-critical, needs audit trail)
CREATE TABLE ai_team_oversight_settings (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    current_version INT NOT NULL DEFAULT 1,
    autonomy VARCHAR(20) NOT NULL DEFAULT 'balanced'
      CHECK (autonomy IN ('autonomous', 'balanced', 'controlled')),
    escalation VARCHAR(20) NOT NULL DEFAULT 'important'
      CHECK (escalation IN ('exceptions', 'important', 'sensitive')),
    sensitive_work JSONB NOT NULL DEFAULT '{"customerCommunication": true, "financialActions": true, "dataChanges": false, "externalPublishing": true, "hiringDecisions": false}',
    communication VARCHAR(20) NOT NULL DEFAULT 'review'
      CHECK (communication IN ('draft', 'auto', 'review')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Version history for oversight settings (audit trail)
CREATE TABLE ai_team_oversight_settings_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    version INT NOT NULL,
    -- Snapshot of all fields
    autonomy VARCHAR(20) NOT NULL,
    escalation VARCHAR(20) NOT NULL,
    sensitive_work JSONB NOT NULL,
    communication VARCHAR(20) NOT NULL,
    -- Metadata (follows existing pattern from ai_team_versions)
    source VARCHAR(20) NOT NULL CHECK (source IN ('create', 'manual', 'api')),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, version)
);

-- Indexes for efficient lookups [FIX: BE-002]
CREATE INDEX idx_oversight_versions_tenant ON ai_team_oversight_settings_versions(tenant_id);
CREATE INDEX idx_oversight_versions_tenant_latest ON ai_team_oversight_settings_versions(tenant_id, version DESC);

-- Auto-update trigger for updated_at (uses shared function per plan)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_ai_team_oversight_settings_updated_at
    BEFORE UPDATE ON ai_team_oversight_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE ai_team_oversight_settings IS 'Tenant-level oversight configuration for HITL enforcement. Determines autonomy levels and sensitive work categories.';
COMMENT ON COLUMN ai_team_oversight_settings.autonomy IS 'autonomous=high trust, balanced=moderate oversight, controlled=strict approval';
COMMENT ON COLUMN ai_team_oversight_settings.escalation IS 'exceptions=only errors, important=key actions, sensitive=all flagged work';
COMMENT ON COLUMN ai_team_oversight_settings.sensitive_work IS 'Categories that require human review: customerCommunication, financialActions, dataChanges, externalPublishing, hiringDecisions';
COMMENT ON COLUMN ai_team_oversight_settings.communication IS 'draft=save as draft, auto=send immediately, review=queue for approval';
