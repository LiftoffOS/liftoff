-- Control Plane Initial Schema
-- Per Section 1: Control plane owns commercial and platform truth

-- Accounts
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    stripe_customer_id VARCHAR(255),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Subscriptions
-- Per Section 13: Stripe subscriptions for commercial plan
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id),
    plan_id VARCHAR(255) NOT NULL,
    stripe_subscription_id VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    version INTEGER NOT NULL DEFAULT 1,
    current_period_start TIMESTAMP WITH TIME ZONE,
    current_period_end TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tenants
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    gcp_project_id VARCHAR(255),
    database_name VARCHAR(255),
    migration_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Plans (for billing)
-- Per Section 13: Control plane owns plans
CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    stripe_price_id VARCHAR(255),
    included_credits INTEGER NOT NULL DEFAULT 0,
    max_agents INTEGER NOT NULL DEFAULT 5,
    max_workflows INTEGER NOT NULL DEFAULT 10,
    features JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Entitlements
-- Per Section 13: Runtime-facing entitlement fields
-- Per Section 15: Tenant-level quotas
CREATE TABLE entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID UNIQUE NOT NULL REFERENCES tenants(id),
    version INTEGER NOT NULL DEFAULT 1,
    tenant_operational_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    agent_execution_allowed BOOLEAN NOT NULL DEFAULT false,
    remaining_included_credits INTEGER NOT NULL DEFAULT 0,
    overage_allowed BOOLEAN NOT NULL DEFAULT false,
    max_active_agents INTEGER NOT NULL DEFAULT 5,
    max_active_workflows INTEGER NOT NULL DEFAULT 10,
    max_actions_per_minute INTEGER NOT NULL DEFAULT 60,
    max_reflection_runs_per_day INTEGER NOT NULL DEFAULT 10,
    -- Per Section 15: Additional tenant-level quotas
    max_queued_tasks INTEGER NOT NULL DEFAULT 100,
    max_connector_writes_per_minute INTEGER NOT NULL DEFAULT 30,
    db_concurrency_budget INTEGER NOT NULL DEFAULT 10,
    included_monthly_credits INTEGER NOT NULL DEFAULT 1000,
    overage_ceiling INTEGER NOT NULL DEFAULT 500,
    max_reflection_runs_per_week INTEGER NOT NULL DEFAULT 50,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Overage Rules
-- Per Section 13: Control plane owns overage rules
CREATE TABLE overage_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    plan_id UUID NOT NULL REFERENCES plans(id),
    overage_rate_per_credit DECIMAL(10,4) NOT NULL DEFAULT 0.01,
    overage_ceiling INTEGER,
    billing_threshold INTEGER,
    notification_threshold INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Agent Quotas
-- Per Section 15: Agent-level quotas
CREATE TABLE agent_quotas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    agent_id UUID, -- NULL for tenant defaults
    max_retries INTEGER NOT NULL DEFAULT 3,
    max_child_tasks INTEGER NOT NULL DEFAULT 10,
    max_workflow_depth INTEGER NOT NULL DEFAULT 5,
    max_external_writes_per_interval INTEGER NOT NULL DEFAULT 100,
    external_writes_interval_seconds INTEGER NOT NULL DEFAULT 60,
    max_task_runtime_duration_seconds INTEGER NOT NULL DEFAULT 300,
    max_reflection_frequency_hours INTEGER NOT NULL DEFAULT 24,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tenant_id, agent_id)
);

-- Deployments
CREATE TABLE deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    artifact_ref VARCHAR(512) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    approved_at TIMESTAMP WITH TIME ZONE,
    deployed_at TIMESTAMP WITH TIME ZONE
);

-- Model Registry
-- Per Section 17: Approved model list
CREATE TABLE models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    model_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'approved',
    capabilities JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Model Configs per tenant
-- Per Section 17: Routing policy
CREATE TABLE model_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    model_id UUID NOT NULL REFERENCES models(id),
    version INTEGER NOT NULL DEFAULT 1,
    routing_policy JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tenant_id, model_id)
);

-- Prompt Templates
-- Per Section 17: Prompt template versions
CREATE TABLE prompt_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name VARCHAR(255) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL,
    variables JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Prompt Bundles
CREATE TABLE prompt_bundles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name VARCHAR(255) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    templates JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    approved_at TIMESTAMP WITH TIME ZONE
);

-- Validator Hook Versions
-- Per Section 17: Control plane owns validator hook versions
CREATE TABLE validator_hook_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    hook_type VARCHAR(100) NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    approved_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(name, version)
);

-- Rollout Approvals
-- Per Section 17: Control plane owns rollout approvals
CREATE TABLE rollout_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(100) NOT NULL, -- 'model', 'prompt_bundle', 'validator_hook'
    entity_id UUID NOT NULL,
    entity_version INTEGER NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    requested_by VARCHAR(255) NOT NULL,
    approved_by VARCHAR(255),
    rollout_percentage INTEGER NOT NULL DEFAULT 0,
    target_tenants JSONB DEFAULT '[]', -- specific tenant IDs or empty for all
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    approved_at TIMESTAMP WITH TIME ZONE,
    rolled_out_at TIMESTAMP WITH TIME ZONE
);

-- Feature Flags
CREATE TABLE feature_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    enabled BOOLEAN NOT NULL DEFAULT false,
    tenant_overrides JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Meter Definitions
-- Per Section 13: Meter definitions
CREATE TABLE meter_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    stripe_meter_id VARCHAR(255),
    unit VARCHAR(50) NOT NULL,
    aggregation_type VARCHAR(50) NOT NULL DEFAULT 'sum',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Passkey Credentials for WebAuthn
-- Passwordless authentication support
CREATE TABLE passkeys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,  -- Firebase UID
    credential_id TEXT UNIQUE NOT NULL,  -- base64url encoded credential ID
    public_key TEXT NOT NULL,  -- base64url encoded public key (COSE format)
    counter INTEGER NOT NULL DEFAULT 0,  -- signature counter for replay protection
    device_name VARCHAR(255),  -- friendly name (e.g., "Mac", "iPhone")
    transports TEXT[],  -- supported transports (usb, nfc, ble, internal)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for common queries
CREATE INDEX idx_subscriptions_account ON subscriptions(account_id);
CREATE INDEX idx_tenants_account ON tenants(account_id);
CREATE INDEX idx_entitlements_tenant ON entitlements(tenant_id);
CREATE INDEX idx_deployments_tenant ON deployments(tenant_id);
CREATE INDEX idx_model_configs_tenant ON model_configs(tenant_id);
CREATE INDEX idx_prompt_templates_tenant ON prompt_templates(tenant_id);
CREATE INDEX idx_prompt_bundles_tenant ON prompt_bundles(tenant_id);
CREATE INDEX idx_passkeys_user_id ON passkeys(user_id);
CREATE INDEX idx_passkeys_credential_id ON passkeys(credential_id);
