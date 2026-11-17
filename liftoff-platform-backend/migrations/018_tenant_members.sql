-- Tenant member roles
CREATE TYPE tenant_member_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE tenant_invite_status AS ENUM ('pending', 'accepted', 'declined', 'expired', 'revoked');

-- Tenant members table
CREATE TABLE tenant_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role tenant_member_role NOT NULL,
    invited_by UUID REFERENCES accounts(id),
    invited_at TIMESTAMPTZ,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, account_id)
);

-- Tenant invitations table
CREATE TABLE tenant_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role tenant_member_role NOT NULL DEFAULT 'member',
    -- [SE-002/BE-002] Store hashed token, not plaintext
    invite_token_hash VARCHAR(64) NOT NULL,  -- SHA-256 hash
    status tenant_invite_status NOT NULL DEFAULT 'pending',
    invited_by UUID NOT NULL REFERENCES accounts(id),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    account_id UUID REFERENCES accounts(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit table with integrity protection [SE-006]
CREATE TABLE tenant_member_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    account_id UUID,
    action VARCHAR(50) NOT NULL,
    changes JSONB,
    actor_id UUID,
    -- [BE-010] Include before/after state for role changes
    previous_state JSONB,
    new_state JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- [SE-006] Make audit table append-only
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit records cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_immutable
    BEFORE UPDATE OR DELETE ON tenant_member_audit
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

-- Indexes [BE-001, BE-004]
CREATE INDEX idx_tenant_members_tenant ON tenant_members(tenant_id);
CREATE INDEX idx_tenant_members_account ON tenant_members(account_id);
CREATE INDEX idx_tenant_invitations_token ON tenant_invitations(invite_token_hash) WHERE status = 'pending';
-- [BE-001] Index for email lookups
CREATE INDEX idx_tenant_invitations_email ON tenant_invitations(email) WHERE status = 'pending';
-- [BE-004] Audit table indexes
CREATE INDEX idx_tenant_member_audit_tenant ON tenant_member_audit(tenant_id);
CREATE INDEX idx_tenant_member_audit_created ON tenant_member_audit(created_at DESC);

-- [BE-005] Prevent removing last owner
CREATE OR REPLACE FUNCTION check_last_owner()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.role = 'owner' THEN
        IF (SELECT COUNT(*) FROM tenant_members WHERE tenant_id = OLD.tenant_id AND role = 'owner') <= 1 THEN
            RAISE EXCEPTION 'Cannot remove the last owner of a tenant';
        END IF;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_last_owner_removal
    BEFORE DELETE ON tenant_members
    FOR EACH ROW EXECUTE FUNCTION check_last_owner();

-- [SE-010] Database-level expiry enforcement
CREATE OR REPLACE FUNCTION expire_old_invitations()
RETURNS void AS $$
BEGIN
    UPDATE tenant_invitations
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'pending' AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Backfill existing owners [BE-009+SE-009+TE-005]
DO $$
DECLARE
    orphaned_count INTEGER;
BEGIN
    -- Verify no orphaned references before backfill
    SELECT COUNT(*) INTO orphaned_count
    FROM tenants t
    WHERE t.account_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id);

    IF orphaned_count > 0 THEN
        RAISE WARNING 'Found % tenants with invalid account_id references', orphaned_count;
    END IF;

    -- Perform backfill
    INSERT INTO tenant_members (tenant_id, account_id, role, joined_at)
    SELECT t.id, t.account_id, 'owner', t.created_at
    FROM tenants t
    INNER JOIN accounts a ON t.account_id = a.id  -- Only valid references
    WHERE t.account_id IS NOT NULL
    ON CONFLICT (tenant_id, account_id) DO NOTHING;

    RAISE NOTICE 'Backfill complete. Migrated % owners',
        (SELECT COUNT(*) FROM tenant_members WHERE role = 'owner');
END $$;
