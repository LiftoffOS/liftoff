-- Tenant Promotion Tables
-- Per Section 22 Phase 5: Tenant promotion tooling

-- Tenant Promotions tracking
CREATE TABLE IF NOT EXISTS tenant_promotions (
    id VARCHAR(100) PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    current_step INTEGER NOT NULL DEFAULT 0,
    total_steps INTEGER NOT NULL DEFAULT 9,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    error TEXT,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Promotion snapshots for data consistency
CREATE TABLE IF NOT EXISTS promotion_snapshots (
    id VARCHAR(100) PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    promotion_id VARCHAR(100) NOT NULL REFERENCES tenant_promotions(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    validated_at TIMESTAMP WITH TIME ZONE,
    row_counts JSONB
);

-- Track migrated tenant data for cleanup
CREATE TABLE IF NOT EXISTS migrated_tenant_data (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
    promotion_id VARCHAR(100) NOT NULL REFERENCES tenant_promotions(id),
    migrated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    cleanup_eligible_at TIMESTAMP WITH TIME ZONE NOT NULL,
    cleaned_up_at TIMESTAMP WITH TIME ZONE,
    cleanup_status VARCHAR(50) DEFAULT 'pending'
);

-- Add database tier columns to tenants table if not exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenants' AND column_name = 'database_tier') THEN
        ALTER TABLE tenants ADD COLUMN database_tier VARCHAR(50) DEFAULT 'shared';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenants' AND column_name = 'database_connection') THEN
        ALTER TABLE tenants ADD COLUMN database_connection VARCHAR(255);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenants' AND column_name = 'promoted_at') THEN
        ALTER TABLE tenants ADD COLUMN promoted_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tenant_promotions_tenant ON tenant_promotions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_promotions_status ON tenant_promotions(status);
CREATE INDEX IF NOT EXISTS idx_migrated_tenant_data_cleanup ON migrated_tenant_data(cleanup_eligible_at)
    WHERE cleanup_status = 'pending';
