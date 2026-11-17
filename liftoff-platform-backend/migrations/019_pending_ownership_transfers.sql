-- [SE-007] Pending ownership transfers table for two-step confirmation
CREATE TABLE pending_ownership_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    current_owner_id UUID NOT NULL REFERENCES accounts(id),
    new_owner_id UUID NOT NULL REFERENCES accounts(id),
    -- Store hashed confirmation token
    confirmation_token_hash VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired', 'cancelled')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only one pending transfer per tenant at a time (partial unique index)
CREATE UNIQUE INDEX idx_pending_transfers_tenant_unique
    ON pending_ownership_transfers(tenant_id)
    WHERE status = 'pending';

-- Index for token lookup
CREATE INDEX idx_pending_transfers_token ON pending_ownership_transfers(confirmation_token_hash) WHERE status = 'pending';

-- Index for cleanup
CREATE INDEX idx_pending_transfers_expires ON pending_ownership_transfers(expires_at) WHERE status = 'pending';
