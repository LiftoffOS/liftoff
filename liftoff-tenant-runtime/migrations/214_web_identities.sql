CREATE TABLE web_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  identity_name TEXT NOT NULL,
  vendor TEXT NOT NULL CHECK (vendor IN ('anchor')),
  vendor_identity_id TEXT NOT NULL,
  vendor_metadata JSONB NOT NULL DEFAULT '{}',
  service_name TEXT NOT NULL,
  login_url TEXT NOT NULL,
  created_by_agent_id UUID,
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (tenant_id, identity_name)
);

CREATE INDEX idx_web_identities_tenant ON web_identities (tenant_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_web_identities_vendor_id ON web_identities (vendor_identity_id);
