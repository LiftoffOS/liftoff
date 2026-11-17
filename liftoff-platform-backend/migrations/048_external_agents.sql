-- External Agents Schema
-- Manages external AI agent configurations for A2A collaboration
-- Following AI Teams pattern from 016_ai_teams.sql and 023_ai_team_versions.sql

-- External Agents table
CREATE TABLE external_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    endpoint_url TEXT NOT NULL,
    description TEXT,
    connection_type VARCHAR(20) NOT NULL CHECK (connection_type IN ('automatic', 'custom')),
    auth_type VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'api_key', 'bearer_token', 'custom_headers')),
    -- Credential reference (actual credentials in tenant's Secret Manager)
    -- Pattern: external-agent-{id}-{tenantId}
    credential_secret_name TEXT,
    collaboration_mode VARCHAR(30) NOT NULL CHECK (collaboration_mode IN ('request_help', 'receive_delegated', 'two_way', 'observe_only')),
    -- LLM-analyzed content (human-readable for UI and prompts)
    summary TEXT,
    collaboration_hints TEXT,
    detected_capabilities JSONB NOT NULL DEFAULT '[]',
    detected_resources JSONB NOT NULL DEFAULT '[]',
    tool_classifications JSONB NOT NULL DEFAULT '{}',
    -- Raw MCP definitions (for runtime invocation by Tenant Runtime)
    raw_mcp_tools JSONB NOT NULL DEFAULT '[]',
    raw_mcp_resources JSONB NOT NULL DEFAULT '[]',
    -- Collaboration config
    allowed_team_ids UUID[] NOT NULL DEFAULT '{}',
    request_rules JSONB NOT NULL DEFAULT '[]',
    -- Status tracking
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'disconnected', 'error', 'pending_review')),
    -- Re-discovery tracking (for admin review when capabilities change)
    capability_changes JSONB,
    capability_source VARCHAR(20) NOT NULL DEFAULT 'mcp_discovery' CHECK (capability_source IN ('mcp_discovery', 'manual')),
    -- Health monitoring
    last_checked_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    -- Versioning (like ai_teams)
    current_version INTEGER NOT NULL DEFAULT 1,
    -- Idempotency for creation
    idempotency_key TEXT UNIQUE,
    -- Soft delete
    deleted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- External agent versions (like ai_team_versions)
CREATE TABLE external_agent_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_agent_id UUID NOT NULL REFERENCES external_agents(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    summary TEXT,
    collaboration_hints TEXT,
    detected_capabilities JSONB NOT NULL DEFAULT '[]',
    detected_resources JSONB NOT NULL DEFAULT '[]',
    tool_classifications JSONB NOT NULL DEFAULT '{}',
    allowed_team_ids UUID[] NOT NULL DEFAULT '{}',
    request_rules JSONB NOT NULL DEFAULT '[]',
    collaboration_mode VARCHAR(30) NOT NULL,
    source VARCHAR(20) NOT NULL DEFAULT 'create' CHECK (source IN ('create', 'discover', 'manual')),
    created_by UUID REFERENCES accounts(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(external_agent_id, version)
);

-- Performance indexes
CREATE INDEX idx_external_agents_tenant ON external_agents(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_external_agents_status ON external_agents(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_external_agents_tenant_status ON external_agents(tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_external_agents_tenant_created ON external_agents(tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_external_agent_versions_agent ON external_agent_versions(external_agent_id);
CREATE INDEX idx_external_agent_versions_agent_version ON external_agent_versions(external_agent_id, version DESC);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_external_agents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_external_agents_updated_at
    BEFORE UPDATE ON external_agents
    FOR EACH ROW
    EXECUTE FUNCTION update_external_agents_updated_at();

-- Add external_agent_ids to ai_teams table for team-external agent relationships
ALTER TABLE ai_teams ADD COLUMN external_agent_ids UUID[] NOT NULL DEFAULT '{}';
