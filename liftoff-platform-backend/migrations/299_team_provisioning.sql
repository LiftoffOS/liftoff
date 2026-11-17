-- Team-preset provisioning: durable, idempotent, crash-recoverable creation of a
-- multi-role AI team from a preset. A provisioning run creates one agent per preset
-- role; per-role progress and agent provenance are durable so a retry resumes without
-- duplicating agents. All three tables are tenant-scoped with FORCE row-level security.

CREATE TABLE team_provisioning_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  preset_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,                              -- canonical hash of the provision body
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','compensated','failed')),
  created_agent_ids UUID[] NOT NULL DEFAULT '{}',
  workforce_plan_id UUID,
  error TEXT,
  locked_at TIMESTAMPTZ,                                   -- lease; a stale lease is reclaimable
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),                    -- tenant-scoped idempotency
  UNIQUE (id, tenant_id)                                   -- composite FK target for the roles table
);

CREATE TABLE team_provisioning_run_roles (
  run_id UUID NOT NULL,
  tenant_id UUID NOT NULL,                                 -- carried for RLS + the composite FK
  role_key TEXT NOT NULL,
  agent_id UUID NOT NULL,                                  -- the created/adopted agent for this role
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','creating','created','failed','compensated')),
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, role_key),
  FOREIGN KEY (run_id, tenant_id)
    REFERENCES team_provisioning_runs (id, tenant_id) ON DELETE CASCADE
);

-- m131 dropped internal_agents.workforce_plan_id; provenance is the durable crash-safe
-- create key (existence check per (run_id, role_key)) and the new home of workforce-plan linkage.
CREATE TABLE internal_agent_provenance (
  agent_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  provisioning_run_id UUID,
  role_key TEXT,
  workforce_plan_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_iap_run ON internal_agent_provenance (tenant_id, provisioning_run_id, role_key);

-- FORCE row-level security + tenant policy on all three (app.current_tenant_id GUC).
ALTER TABLE team_provisioning_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_provisioning_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tpr_tenant ON team_provisioning_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE team_provisioning_run_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_provisioning_run_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tprr_tenant ON team_provisioning_run_roles
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE internal_agent_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_agent_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY iap_tenant ON internal_agent_provenance
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
