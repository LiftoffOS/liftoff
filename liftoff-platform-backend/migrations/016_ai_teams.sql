-- AI Teams Schema
-- Manages AI team/agent configurations

-- AI Teams table
CREATE TABLE ai_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role VARCHAR(255) NOT NULL,
    responsibilities TEXT,
    integrations JSONB DEFAULT '[]',
    additional_context TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
    tasks_completed INTEGER NOT NULL DEFAULT 0,
    monthly_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
    last_active TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,  -- Soft delete (DE-003)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- AI Team audit trail (DE-004)
CREATE TABLE ai_team_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ai_team_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    action VARCHAR(20) NOT NULL,  -- 'created', 'updated', 'deleted', 'status_changed'
    changes JSONB,
    actor_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Idempotency keys for create operations (DE-001)
CREATE TABLE ai_team_idempotency_keys (
    key VARCHAR(255) PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    ai_team_id UUID REFERENCES ai_teams(id),
    response JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Performance indexes (BE-002)
CREATE INDEX idx_ai_teams_tenant_id ON ai_teams(tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_ai_teams_tenant_status ON ai_teams(tenant_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_ai_teams_tenant_created ON ai_teams(tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_ai_teams_last_active ON ai_teams(last_active DESC) WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX idx_ai_team_audit_team ON ai_team_audit(ai_team_id, created_at DESC);
CREATE INDEX idx_ai_team_idempotency_expires ON ai_team_idempotency_keys(expires_at);

-- Cleanup expired idempotency keys (run via cron/scheduler)
CREATE OR REPLACE FUNCTION cleanup_expired_ai_team_idempotency_keys()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM ai_team_idempotency_keys WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
