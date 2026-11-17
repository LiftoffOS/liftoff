-- migrations/036_staff_roles.sql
-- Staff role assignments with audit trail for internal console access control

-- Staff role assignments with audit trail
CREATE TABLE staff_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('csm', 'engineer', 'support', 'admin', 'super_admin')),
  granted_by UUID NOT NULL REFERENCES accounts(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES accounts(id)
);

-- Partial unique constraint: only one active role per account
CREATE UNIQUE INDEX idx_staff_roles_unique_active ON staff_roles(account_id, role) WHERE revoked_at IS NULL;
CREATE INDEX idx_staff_roles_account ON staff_roles(account_id) WHERE revoked_at IS NULL;

-- Internal console audit log
CREATE TABLE internal_console_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES accounts(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,
  account_id UUID REFERENCES accounts(id),
  old_value JSONB,
  new_value JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_internal_audit_actor ON internal_console_audit(actor_id, created_at DESC);
CREATE INDEX idx_internal_audit_account ON internal_console_audit(account_id, created_at DESC);
