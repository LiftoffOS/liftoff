-- Migration 230: add tenant_id column to workflow_escalations.
--
-- The table predates multi-tenancy and was carrying agent_id + workflow_id
-- only. Two code paths INSERT into it:
--   1. src/agent-execution/service.ts createEscalation (legacy, includes
--      tenant_id in column list — fails at the DB layer because the
--      column doesn't exist)
--   2. src/agent-execution/engine/escalation-helper.ts createEscalation
--      (newer SDK-engine path, did NOT include tenant_id at all)
--
-- The discrepancy meant SDK-engine escalations silently dropped tenant scope
-- while legacy escalations errored out at the DB layer. This migration adds
-- the column, backfills from `workflows.tenant_id` via the FK, and the
-- companion commit consolidates both code paths into the helper which now
-- always populates tenant_id.

ALTER TABLE workflow_escalations
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Backfill from the parent workflow row. Every workflow_escalations row has
-- a workflow_id FK; workflows.tenant_id was added back in migration 011
-- so this is safe.
UPDATE workflow_escalations we
   SET tenant_id = w.tenant_id
  FROM workflows w
 WHERE we.workflow_id = w.id
   AND we.tenant_id IS NULL;

-- Index for the SELECT WHERE tenant_id = $1 access pattern used by
-- src/validation-rig/production-validation.ts:615 and any future
-- per-tenant escalation reporting.
CREATE INDEX IF NOT EXISTS workflow_escalations_tenant_id_idx
  ON workflow_escalations (tenant_id)
  WHERE tenant_id IS NOT NULL;
