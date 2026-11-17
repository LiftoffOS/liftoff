-- Migration 003: Add missing tables referenced in code
-- Per Section 7: Workflow checkpoint, resume, and partial-failure contract
-- Per Section 9: Instruction compiler and customer approval

-- Instructions Table
-- Per Section 9: The compile-review-activate flow produces internal DSL/policy spec
CREATE TABLE instructions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    agent_id UUID NOT NULL REFERENCES agents(id),
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    -- Status: draft → pending_approval → approved → active → deprecated
    raw_input JSONB NOT NULL,
    normalized_spec JSONB,
    dsl_output JSONB,
    preview_summary TEXT,
    preview_level_1 TEXT, -- Plain-language summary
    preview_level_2 JSONB, -- Systems accessed, written to, key triggers
    preview_level_3 JSONB, -- Detailed policy scope and escalation rules
    preview_level_4 JSONB, -- Example scenarios
    validation_errors JSONB,
    approved_by VARCHAR(255),
    approved_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (agent_id, version)
);

-- Child Tasks Table
-- Per Section 6: Agents may propose child tasks within policy
CREATE TABLE child_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_task_id UUID NOT NULL REFERENCES workflow_tasks(id),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    idempotency_key VARCHAR(255) NOT NULL,
    result JSONB,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Workflow Hierarchy Table
-- Per Section 6: Support for sub-workflows and nesting depth tracking
CREATE TABLE workflow_hierarchy (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_workflow_id UUID NOT NULL REFERENCES workflows(id),
    child_workflow_id UUID NOT NULL REFERENCES workflows(id),
    depth INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (parent_workflow_id, child_workflow_id)
);

-- Compensation Actions Table
-- Per Section 7: External action contract - persist action intents and outcomes
CREATE TABLE compensation_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_id UUID NOT NULL REFERENCES actions(id),
    compensation_type VARCHAR(50) NOT NULL,
    -- Types: reverse, restore, semantic, manual
    target_connector VARCHAR(100) NOT NULL,
    target_entity_type VARCHAR(100) NOT NULL,
    target_ref VARCHAR(255) NOT NULL,
    compensation_spec JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    -- Status: pending → in_progress → completed → failed
    executed_at TIMESTAMP WITH TIME ZONE,
    result JSONB,
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Compensation Plans Table
-- Per Section 7: Compensation state tracking on workflows
CREATE TABLE compensation_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    -- Status: pending → in_progress → completed → failed → aborted
    actions_total INTEGER NOT NULL DEFAULT 0,
    actions_completed INTEGER NOT NULL DEFAULT 0,
    actions_failed INTEGER NOT NULL DEFAULT 0,
    compensation_strategy VARCHAR(50) NOT NULL DEFAULT 'sequential',
    -- Strategy: sequential, parallel, best_effort
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- NOTE: audit_logs table moved to 016_audit_logs.sql with enhanced schema
-- including ai_team_id, thread_id, invocation_id, immutability rules, and RLS

-- Connector Credentials Table
-- Per Section 11: Credentials in Secret Manager
-- This table tracks which secrets exist, actual values are in Secret Manager
CREATE TABLE connector_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID NOT NULL REFERENCES connectors(id),
    credential_type VARCHAR(50) NOT NULL,
    -- Types: oauth2, api_key, basic_auth, service_account
    secret_name VARCHAR(255) NOT NULL,
    -- Reference to Secret Manager secret
    scopes JSONB,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_refreshed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Credit Cost Model Table
-- Per Section 12: Action-credit ledger
CREATE TABLE credit_cost_model (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID,
    -- NULL tenant_id = system default
    action_type VARCHAR(100) NOT NULL,
    connector VARCHAR(100),
    -- NULL connector = all connectors
    credits_per_action INTEGER NOT NULL DEFAULT 1,
    effective_from TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    effective_until TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (tenant_id, action_type, connector, effective_from)
);

-- Action Allowlist Table
-- Per Section 10: Tool gateway enforces action allowlist
CREATE TABLE action_allowlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    agent_id UUID,
    -- NULL agent_id = applies to all agents
    instruction_version INTEGER,
    -- NULL = applies to all versions
    connector VARCHAR(100) NOT NULL,
    action_type VARCHAR(100) NOT NULL,
    entity_types JSONB,
    -- NULL = all entity types allowed
    field_restrictions JSONB,
    -- Per-field access controls
    conditions JSONB,
    -- Additional conditions/predicates
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for new tables
CREATE INDEX idx_instructions_agent ON instructions(agent_id);
CREATE INDEX idx_instructions_status ON instructions(status);
CREATE INDEX idx_child_tasks_parent ON child_tasks(parent_task_id);
CREATE INDEX idx_child_tasks_workflow ON child_tasks(workflow_id);
CREATE INDEX idx_workflow_hierarchy_parent ON workflow_hierarchy(parent_workflow_id);
CREATE INDEX idx_workflow_hierarchy_child ON workflow_hierarchy(child_workflow_id);
CREATE INDEX idx_compensation_actions_action ON compensation_actions(action_id);
CREATE INDEX idx_compensation_plans_workflow ON compensation_plans(workflow_id);
-- NOTE: audit_logs indexes moved to 016_audit_logs.sql
CREATE INDEX idx_connector_credentials_connector ON connector_credentials(connector_id);
CREATE INDEX idx_credit_cost_model_tenant ON credit_cost_model(tenant_id);
CREATE INDEX idx_credit_cost_model_action ON credit_cost_model(action_type);
CREATE INDEX idx_action_allowlists_tenant ON action_allowlists(tenant_id);
CREATE INDEX idx_action_allowlists_agent ON action_allowlists(agent_id);
