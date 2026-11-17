-- Migration 012: Kill Switch Tables
-- Per Section 12: Enforce kill switches for connectors and workflows

-- Connector kill switches (disable specific connectors for a tenant)
CREATE TABLE IF NOT EXISTS connector_kill_switches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(255) NOT NULL,
    connector VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    reason TEXT,
    activated_by VARCHAR(255),
    activated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connector_kill_switches_tenant ON connector_kill_switches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_connector_kill_switches_lookup ON connector_kill_switches(tenant_id, connector, enabled);
CREATE INDEX IF NOT EXISTS idx_connector_kill_switches_expiry ON connector_kill_switches(expires_at) WHERE expires_at IS NOT NULL;

-- Unique constraint to prevent duplicate entries
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_kill_switches_unique
    ON connector_kill_switches(tenant_id, connector)
    WHERE enabled = true;

-- Workflow kill switches (disable workflows for a tenant or specific agent)
CREATE TABLE IF NOT EXISTS workflow_kill_switches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(255) NOT NULL,
    agent_id UUID,  -- NULL means all agents for this tenant
    scope VARCHAR(50) NOT NULL DEFAULT 'all',  -- 'all', 'new_only', 'scheduled'
    enabled BOOLEAN NOT NULL DEFAULT true,
    reason TEXT,
    activated_by VARCHAR(255),
    activated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_kill_switches_tenant ON workflow_kill_switches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflow_kill_switches_lookup ON workflow_kill_switches(tenant_id, agent_id, enabled);
CREATE INDEX IF NOT EXISTS idx_workflow_kill_switches_expiry ON workflow_kill_switches(expires_at) WHERE expires_at IS NOT NULL;

-- Unique constraint to prevent duplicate entries per tenant/agent
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_kill_switches_unique
    ON workflow_kill_switches(tenant_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE enabled = true;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_kill_switch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER connector_kill_switches_updated_at
    BEFORE UPDATE ON connector_kill_switches
    FOR EACH ROW
    EXECUTE FUNCTION update_kill_switch_updated_at();

CREATE TRIGGER workflow_kill_switches_updated_at
    BEFORE UPDATE ON workflow_kill_switches
    FOR EACH ROW
    EXECUTE FUNCTION update_kill_switch_updated_at();

-- Add comments
COMMENT ON TABLE connector_kill_switches IS 'Per Section 12: Kill switches to disable specific connectors for a tenant';
COMMENT ON TABLE workflow_kill_switches IS 'Per Section 12: Kill switches to disable workflows for a tenant or agent';
COMMENT ON COLUMN workflow_kill_switches.scope IS 'Scope of the kill switch: all (stop all workflows), new_only (prevent new workflows), scheduled (stop scheduled triggers)';
