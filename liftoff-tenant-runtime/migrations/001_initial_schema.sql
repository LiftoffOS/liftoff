-- Tenant Runtime Initial Schema
-- Per Section 1: Tenant runtime owns execution truth

-- Tenants table (required for FK references)
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Common function for auto-updating updated_at columns
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Agents
-- Per Section 8: Agent lifecycle
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    instruction_id UUID,
    instruction_version INTEGER DEFAULT 1,
    lifecycle VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    runtime_status VARCHAR(50) NOT NULL DEFAULT 'IDLE',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Agent Audit Log
-- Per Section 8: Every transition is audit-logged
CREATE TABLE agent_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    field VARCHAR(100) NOT NULL,
    old_value TEXT,
    new_value TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workflows
-- Per Section 7: Required tables
CREATE TABLE workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    agent_id UUID NOT NULL REFERENCES agents(id),
    objective TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    compensation_state JSONB,
    final_outcome JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workflow Tasks
-- Per Section 7: Required tables
CREATE TABLE workflow_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    lease_id UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    idempotency_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workflow Task Dependencies
-- Per Section 7: Required tables
CREATE TABLE workflow_task_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES workflow_tasks(id),
    depends_on_task_id UUID NOT NULL REFERENCES workflow_tasks(id)
);

-- Workflow Task Outputs
-- Per Section 7: Required tables
CREATE TABLE workflow_task_outputs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES workflow_tasks(id),
    output JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workflow Handoffs
-- Per Section 7: Required tables
CREATE TABLE workflow_handoffs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    from_agent_id UUID NOT NULL REFERENCES agents(id),
    to_agent_id UUID NOT NULL REFERENCES agents(id),
    task_id UUID NOT NULL REFERENCES workflow_tasks(id),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workflow Escalations
-- Per Section 7: Required tables
CREATE TABLE workflow_escalations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    task_id UUID NOT NULL REFERENCES workflow_tasks(id),
    agent_id UUID REFERENCES agents(id),
    reason TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolution JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workflow Leases
-- Per Section 7: Required tables
CREATE TABLE workflow_leases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES workflow_tasks(id),
    worker_id VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workflow Checkpoints
-- Per Section 7: Required tables
CREATE TABLE workflow_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    task_id UUID NOT NULL REFERENCES workflow_tasks(id),
    state JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Actions
-- Per Section 7: Action persistence for crash recovery
CREATE TABLE actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    agent_id UUID NOT NULL REFERENCES agents(id),
    workflow_id UUID NOT NULL REFERENCES workflows(id),
    task_id UUID NOT NULL REFERENCES workflow_tasks(id),
    idempotency_key VARCHAR(255) UNIQUE NOT NULL,
    connector VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    target_ref VARCHAR(255) NOT NULL,
    pre_action_snapshot JSONB,
    external_response JSONB,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Usage Events
-- Per Section 13: Usage events
CREATE TABLE usage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    workflow_id UUID NOT NULL,
    action_id UUID,
    event_type VARCHAR(100) NOT NULL,
    credits INTEGER NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Burn State
-- Per Section 13: Live burn state
CREATE TABLE burn_state (
    tenant_id UUID PRIMARY KEY,
    billing_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    billing_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    included_credits INTEGER NOT NULL DEFAULT 0,
    used_credits INTEGER NOT NULL DEFAULT 0,
    remaining_credits INTEGER NOT NULL DEFAULT 0,
    overage_credits INTEGER NOT NULL DEFAULT 0,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Refunds
-- Per Section 13: Refunds/reversals
CREATE TABLE refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    action_id UUID NOT NULL REFERENCES actions(id),
    credits INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Cached Entitlements
-- Per Section 4: Local cache of control plane data
CREATE TABLE cached_entitlements (
    tenant_id UUID PRIMARY KEY,
    data JSONB NOT NULL,
    entity_version INTEGER NOT NULL DEFAULT 1,
    operational_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Cached Deployments
CREATE TABLE cached_deployments (
    tenant_id UUID NOT NULL,
    deployment_id UUID NOT NULL,
    status VARCHAR(50) NOT NULL,
    artifact_ref VARCHAR(512) NOT NULL,
    entity_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (tenant_id, deployment_id)
);

-- Cached Prompt Bundles
CREATE TABLE cached_prompt_bundles (
    tenant_id UUID NOT NULL,
    bundle_id UUID NOT NULL,
    status VARCHAR(50) NOT NULL,
    templates JSONB NOT NULL,
    entity_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (tenant_id, bundle_id)
);

-- Cached Feature Flags
CREATE TABLE cached_feature_flags (
    tenant_id UUID PRIMARY KEY,
    flags JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Connectors
-- Per Section 12: Connectors and ingestion
CREATE TABLE connectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    type VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    config JSONB NOT NULL DEFAULT '{}',
    last_sync_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Connector Sync Stats
CREATE TABLE connector_sync_stats (
    connector_id UUID PRIMARY KEY REFERENCES connectors(id),
    last_sync_status VARCHAR(50),
    records_processed INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Connector Records
-- Per Section 12: Normalized records are written into tenant Cloud SQL
CREATE TABLE connector_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connector_id UUID NOT NULL REFERENCES connectors(id),
    entity_type VARCHAR(100) NOT NULL,
    external_id VARCHAR(255) NOT NULL,
    data JSONB NOT NULL,
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (connector_id, entity_type, external_id)
);

-- Reflection Suggestions
-- Per Section 16: Reflection writes suggestions
CREATE TABLE reflection_suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    suggestion TEXT NOT NULL,
    evidence_refs JSONB NOT NULL DEFAULT '[]',
    confidence_score DECIMAL(3,2) NOT NULL,
    recurrence_score DECIMAL(3,2) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Reflection Quotas
-- Per Section 16: Reflection quotas
CREATE TABLE reflection_quotas (
    tenant_id UUID PRIMARY KEY,
    daily_runs_limit INTEGER NOT NULL DEFAULT 10,
    daily_runs_used INTEGER NOT NULL DEFAULT 0,
    weekly_agent_runs_limit INTEGER NOT NULL DEFAULT 5,
    weekly_agent_runs_used INTEGER NOT NULL DEFAULT 0,
    max_concurrent_jobs INTEGER NOT NULL DEFAULT 3,
    current_concurrent_jobs INTEGER NOT NULL DEFAULT 0,
    last_reset_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Human Feedback
-- Per Section 16: Reflection reads human feedback
CREATE TABLE human_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    task_id UUID REFERENCES workflow_tasks(id),
    feedback TEXT NOT NULL,
    feedback_type VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Policy Denials
-- Per Section 16: Reflection reads policy denials
CREATE TABLE policy_denials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id),
    task_id UUID REFERENCES workflow_tasks(id),
    policy_type VARCHAR(100) NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Cached Migration Status
-- Per Section 4: Tenant runtime may pull tenant migration status
CREATE TABLE cached_migration_status (
    tenant_id UUID PRIMARY KEY,
    migration_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    current_version INTEGER NOT NULL DEFAULT 0,
    target_version INTEGER,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    entity_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Reconciliation Reports
-- Per Section 14: Produce an operator-visible reconciliation report before cycle close
CREATE TABLE reconciliation_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    billing_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    billing_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    internal_totals JSONB NOT NULL,
    stripe_totals JSONB NOT NULL,
    deltas JSONB NOT NULL,
    missing_events INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL,
    correction_applied BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Agent Quotas (cached from control plane)
-- Per Section 15: Agent-level quotas
-- Note: agent_id NULL means tenant-level defaults
CREATE TABLE cached_agent_quotas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    agent_id UUID,
    max_retries INTEGER NOT NULL DEFAULT 3,
    max_child_tasks INTEGER NOT NULL DEFAULT 10,
    max_workflow_depth INTEGER NOT NULL DEFAULT 5,
    max_external_writes_per_interval INTEGER NOT NULL DEFAULT 100,
    external_writes_interval_seconds INTEGER NOT NULL DEFAULT 60,
    max_task_runtime_duration_seconds INTEGER NOT NULL DEFAULT 300,
    max_reflection_frequency_hours INTEGER NOT NULL DEFAULT 24,
    entity_version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Unique constraint for tenant+agent lookup (handles NULL agent_id)
CREATE UNIQUE INDEX idx_cached_agent_quotas_tenant_agent
    ON cached_agent_quotas (tenant_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::UUID));

-- Event Versions
-- Per Section 4: The runtime stores the latest applied entity_version
-- and discards stale events. This is the mechanism that protects from
-- out-of-order or redelivered Pub/Sub messages.
CREATE TABLE event_versions (
    tenant_id UUID NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id VARCHAR(255) NOT NULL,
    entity_version INTEGER NOT NULL DEFAULT 1,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (tenant_id, entity_type, entity_id)
);

-- Cached Model Configs
-- Per Section 17: Tenant runtime owns enforcement that only approved configs are used
CREATE TABLE cached_model_configs (
    tenant_id UUID NOT NULL,
    config_id UUID NOT NULL,
    model_id VARCHAR(100) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    settings JSONB NOT NULL DEFAULT '{}',
    use_cases JSONB NOT NULL DEFAULT '[]',
    is_default BOOLEAN NOT NULL DEFAULT false,
    entity_version INTEGER NOT NULL DEFAULT 1,
    approved_at TIMESTAMP WITH TIME ZONE,
    approved_by VARCHAR(255),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (tenant_id, config_id)
);

-- Indexes
CREATE INDEX idx_agents_tenant ON agents(tenant_id);
CREATE INDEX idx_workflows_tenant ON workflows(tenant_id);
CREATE INDEX idx_workflows_agent ON workflows(agent_id);
CREATE INDEX idx_workflow_tasks_workflow ON workflow_tasks(workflow_id);
CREATE INDEX idx_workflow_tasks_status ON workflow_tasks(status);
CREATE INDEX idx_actions_workflow ON actions(workflow_id);
CREATE INDEX idx_actions_idempotency ON actions(idempotency_key);
CREATE INDEX idx_usage_events_tenant ON usage_events(tenant_id);
CREATE INDEX idx_connectors_tenant ON connectors(tenant_id);
CREATE INDEX idx_connector_records_connector ON connector_records(connector_id);
CREATE INDEX idx_reflection_suggestions_agent ON reflection_suggestions(agent_id);
