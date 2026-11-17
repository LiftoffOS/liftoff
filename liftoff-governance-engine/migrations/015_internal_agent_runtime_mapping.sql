-- Migration 015: Internal agent runtime mapping for audit enrichment.
--
-- src/audit/service.ts (insertAuditLog) attempts to resolve an
-- internal_agent_id from an external agent_id + tenant_id pair via:
--   SELECT internal_agent_id FROM internal_agent_runtime_mapping
--   WHERE agent_id = $1 AND tenant_id = $2
-- The table was missing; the failure was caught by a try-catch so audit
-- log writes still succeeded, but the internal_agent_id field was always
-- null in audit entries. This table enables that enrichment.
--
-- Rows are written by the agent-lifecycle subscriber when a platform-backend
-- agent event includes both the external agent_id and its internal runtime ID.

CREATE TABLE IF NOT EXISTS internal_agent_runtime_mapping (
  agent_id            TEXT        NOT NULL,
  tenant_id           TEXT        NOT NULL,
  internal_agent_id   TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_mapping_tenant
  ON internal_agent_runtime_mapping (tenant_id);
