-- Migration 035: Align cached_model_configs with Platform Backend's ModelConfig type
-- The original schema had columns (use_cases, is_default, settings, approved_at, approved_by)
-- that the Platform Backend never sends. The actual data model is:
-- { id, tenantId, modelId, version, routingPolicy }

BEGIN;

-- Drop and recreate with the correct schema
DROP TABLE IF EXISTS cached_model_configs;

CREATE TABLE cached_model_configs (
    id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    model_id VARCHAR(255) NOT NULL,
    routing_policy JSONB NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    entity_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (tenant_id, id)
);

CREATE INDEX idx_cached_model_configs_tenant
    ON cached_model_configs (tenant_id);

COMMIT;
