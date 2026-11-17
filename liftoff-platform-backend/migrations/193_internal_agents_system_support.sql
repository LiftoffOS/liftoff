-- Migration 193: System-agent support in internal_agents
--
-- Platform-owned agents (CAIO, HRBP) need to coexist with tenant agents in
-- the same internal_agents table. They differ structurally:
--   - tenant_id IS NULL (shared across all tenants)
--   - is_system = TRUE
--   - system_role identifies the agent by role
--
-- The check constraint enforces mutual exclusion: every row is either a tenant
-- agent (tenant_id set, is_system=false, system_role NULL) or a system agent
-- (tenant_id NULL, is_system=true, system_role set).

BEGIN;

ALTER TABLE internal_agents ALTER COLUMN tenant_id DROP NOT NULL;

ALTER TABLE internal_agents
  ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE internal_agents
  ADD COLUMN system_role TEXT;

ALTER TABLE internal_agents
  ADD CONSTRAINT internal_agents_system_role_unique UNIQUE (system_role);

ALTER TABLE internal_agents
  ADD CONSTRAINT internal_agents_system_role_chk CHECK (
    (is_system = TRUE  AND system_role IS NOT NULL AND tenant_id IS NULL)
    OR
    (is_system = FALSE AND system_role IS NULL     AND tenant_id IS NOT NULL)
  );

ALTER TABLE internal_agent_versions
  ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE internal_agent_versions
  ADD COLUMN system_role TEXT;

CREATE INDEX idx_internal_agents_system_role
  ON internal_agents (system_role) WHERE is_system = TRUE;

COMMENT ON COLUMN internal_agents.is_system IS
  'TRUE for platform-owned agents (CAIO, HRBP) shared across tenants. FALSE for tenant-provisioned agents.';
COMMENT ON COLUMN internal_agents.system_role IS
  'Role identifier for system agents (e.g. "caio", "hrbp"). NULL for tenant agents. UNIQUE across the table.';

COMMIT;
