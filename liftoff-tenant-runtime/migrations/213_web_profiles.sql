CREATE TABLE web_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  profile_name TEXT NOT NULL,
  vendor TEXT NOT NULL CHECK (vendor IN ('anchor')),
  vendor_profile_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, profile_name)
);
