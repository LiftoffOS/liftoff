-- Migration 033: Fix ALL schema mismatches between code and database
-- Addresses every column/table the code references but doesn't exist

BEGIN;

-- F1: agents.workflow_steps - referenced in agent-execution/service.ts loadRuntimeConfig()
ALTER TABLE agents ADD COLUMN IF NOT EXISTS workflow_steps JSONB;

-- F3: actions.is_external_write - referenced in admission/service.ts getConnectorWritesInLastMinute()
ALTER TABLE actions ADD COLUMN IF NOT EXISTS is_external_write BOOLEAN DEFAULT false;

-- F4: workflow_tasks.started_at - referenced in admission/service.ts getTaskRuntimeSeconds()
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMP WITH TIME ZONE;

-- F2: kill_switches table - admission/service.ts queries a unified kill_switches table
-- but migrations created connector_kill_switches and workflow_kill_switches separately.
-- Create the unified table the code expects.
CREATE TABLE IF NOT EXISTS kill_switches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    switch_type VARCHAR(50) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    reason TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    agent_id UUID,
    connector_type VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kill_switches_tenant_type
    ON kill_switches (tenant_id, switch_type) WHERE enabled = true;

COMMIT;
