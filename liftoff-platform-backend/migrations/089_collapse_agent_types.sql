-- Phase 1b: Collapse agent_type taxonomy from legacy {A,B,C} to canonical {agent,workflow}
--
-- Background:
--   Migration 027 created internal_agents.agent_type VARCHAR(20) NOT NULL DEFAULT 'B'
--   with CHECK (agent_type IN ('A','B','C')). The table was renamed from ai_teams
--   in migration 055 (a pure rename — the check constraint survived with its
--   original auto-generated name like 'ai_teams_agent_type_check').
--
--   This migration:
--     1. Drops any existing CHECK constraint on internal_agents.agent_type
--        (name-agnostic via pg_catalog lookup so it works regardless of what
--        the auto-generated name is).
--     2. Rewrites the data in internal_agents AND internal_agent_versions:
--        A -> agent, B -> agent, C -> workflow.
--     3. Also rewrites the internal_agent_audit.changes JSONB column which
--        may contain historical agentType literals under three shapes:
--        {agentType:X}, {before:{agentType:X}}, {after:{agentType:X}}.
--     3.5. Walks workforce_plans.agents (CAIO workforce planning, shipped in
--        migration 085). Each row's `agents` column is a JSONB array of
--        WorkforcePlanAgentSpec objects each carrying an `agentType` field.
--        Without this walk, reopening a pre-migration plan in the CAIO chat
--        would fail Zod validation (the new narrow enum rejects 'B') and
--        the HRBP agent would emit legacy literals into the new constraint
--        and 400 on provision.
--     4. Deletes internal_agent_idempotency_keys rows that cached pre-migration
--        create responses (24h TTL makes this safe — stragglers expire
--        within a day regardless).
--     5. Adds the new wide CHECK constraint ('agent','workflow').
--     6. Changes the column default from 'B' to 'agent'.
--     7. Adds Phase 4 integrity columns: reviewed_at, reviewed_by,
--        workflow_steps_hash (nullable; app layer enforces presence for
--        workflow agents).
--
-- The mapping is 1:1 lossless: 'B' and 'agent' represent the same runtime
-- concept before and after the taxonomy collapse. No information is lost.
--
-- Phase 1c narrows the Zod enum in code; the DB constraint added here is
-- already the final narrow form, so Phase 1c touches no SQL.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Drop any existing CHECK constraint on internal_agents.agent_type.
--    The constraint was auto-named in migration 027 as ai_teams_agent_type_check
--    (the rename in migration 055 preserved the name since only the table
--    name changes in a RENAME TO). Use pg_catalog lookup so this works even
--    if the name differs.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  check_name TEXT;
BEGIN
  FOR check_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'internal_agents'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%agent_type%'
  LOOP
    EXECUTE format('ALTER TABLE internal_agents DROP CONSTRAINT %I', check_name);
  END LOOP;

  -- Also drop any constraint on internal_agent_versions.agent_type (none
  -- existed in migration 027, but be defensive).
  FOR check_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'internal_agent_versions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%agent_type%'
  LOOP
    EXECUTE format('ALTER TABLE internal_agent_versions DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Rewrite column data on both tables.
-- ---------------------------------------------------------------------------
UPDATE internal_agents
   SET agent_type = 'agent'
 WHERE agent_type IN ('A', 'B');

UPDATE internal_agents
   SET agent_type = 'workflow'
 WHERE agent_type = 'C';

UPDATE internal_agent_versions
   SET agent_type = 'agent'
 WHERE agent_type IN ('A', 'B');

UPDATE internal_agent_versions
   SET agent_type = 'workflow'
 WHERE agent_type = 'C';

-- ---------------------------------------------------------------------------
-- 3. JSONB surgery on internal_agent_audit.changes.
--
--    Shape 1 ('created' action): {agentType: 'B', ...}                    (top-level)
--    Shape 2 ('updated' action): {before: {agentType: 'B'}, after: {...}} (nested)
--    Shape 3 ('status_changed', 'deleted'): no agentType field            (skip)
--
--    Use a temporary helper function for the 1:1 lossless mapping.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _tmp_map_agent_type_literal(val TEXT)
RETURNS TEXT AS $$
  SELECT CASE val
    WHEN 'A' THEN 'agent'
    WHEN 'B' THEN 'agent'
    WHEN 'C' THEN 'workflow'
    ELSE val
  END;
$$ LANGUAGE SQL IMMUTABLE;

-- Path 1: top-level changes.agentType ('created' action)
UPDATE internal_agent_audit
   SET changes = jsonb_set(
         changes,
         '{agentType}',
         to_jsonb(_tmp_map_agent_type_literal(changes->>'agentType'))
       )
 WHERE changes ? 'agentType'
   AND (changes->>'agentType') IN ('A', 'B', 'C');

-- Path 2: nested changes.before.agentType ('updated' action)
UPDATE internal_agent_audit
   SET changes = jsonb_set(
         changes,
         '{before,agentType}',
         to_jsonb(_tmp_map_agent_type_literal(changes->'before'->>'agentType'))
       )
 WHERE jsonb_typeof(changes->'before') = 'object'
   AND (changes->'before'->>'agentType') IN ('A', 'B', 'C');

-- Path 3: nested changes.after.agentType ('updated' action)
UPDATE internal_agent_audit
   SET changes = jsonb_set(
         changes,
         '{after,agentType}',
         to_jsonb(_tmp_map_agent_type_literal(changes->'after'->>'agentType'))
       )
 WHERE jsonb_typeof(changes->'after') = 'object'
   AND (changes->'after'->>'agentType') IN ('A', 'B', 'C');

-- ---------------------------------------------------------------------------
-- 3.5. JSONB surgery on workforce_plans.agents (CAIO workforce planning,
--      shipped in migration 085). Each row's `agents` column is a JSONB
--      array of WorkforcePlanAgentSpec objects, each carrying agentType.
--      Walk the array element-wise, rewriting any legacy literal in place.
--      WITH ORDINALITY preserves the original spec order — the HRBP agent's
--      lastProvisionedSpecs snapshot is keyed by spec ID, not index, but
--      order still matters for human-readable plan display in the CAIO chat.
--
--      Without this walk:
--        - Reopening an existing plan in the CAIO chat would fail Zod
--          validation (the new narrow enum rejects 'B').
--        - The HRBP agent passes spec.agentType straight through to
--          internalAgentService.create, which 400s on the new constraint.
--        - The legacy-literal CI fence (Phase 0) fires on JSONB content.
-- ---------------------------------------------------------------------------
UPDATE workforce_plans wp
   SET agents = (
     SELECT jsonb_agg(
       CASE
         WHEN elem->>'agentType' IN ('A', 'B')
           THEN jsonb_set(elem, '{agentType}', to_jsonb('agent'::text))
         WHEN elem->>'agentType' = 'C'
           THEN jsonb_set(elem, '{agentType}', to_jsonb('workflow'::text))
         ELSE elem
       END
       ORDER BY ordinality
     )
     FROM jsonb_array_elements(wp.agents) WITH ORDINALITY AS t(elem, ordinality)
   )
 WHERE EXISTS (
   SELECT 1
   FROM jsonb_array_elements(wp.agents) AS e
   WHERE e->>'agentType' IN ('A', 'B', 'C')
 );

DROP FUNCTION _tmp_map_agent_type_literal(TEXT);

-- ---------------------------------------------------------------------------
-- 4. Delete idempotency cache rows whose cached response still holds a
--    legacy literal. These self-expire in 24h anyway; deleting here removes
--    the running mess immediately so the legacy-literal CI fence is clean.
-- ---------------------------------------------------------------------------
DELETE FROM internal_agent_idempotency_keys
 WHERE jsonb_typeof(response) = 'object'
   AND (response->>'agentType') IN ('A', 'B', 'C');

-- ---------------------------------------------------------------------------
-- 5. Add the new CHECK constraint ('agent','workflow') on both tables.
-- ---------------------------------------------------------------------------
ALTER TABLE internal_agents
  ADD CONSTRAINT internal_agents_agent_type_check
  CHECK (agent_type IN ('agent', 'workflow'));

ALTER TABLE internal_agent_versions
  ADD CONSTRAINT internal_agent_versions_agent_type_check
  CHECK (agent_type IN ('agent', 'workflow'));

-- ---------------------------------------------------------------------------
-- 6. Change the column default from 'B' to 'agent' on both tables.
-- ---------------------------------------------------------------------------
ALTER TABLE internal_agents
  ALTER COLUMN agent_type SET DEFAULT 'agent';

ALTER TABLE internal_agent_versions
  ALTER COLUMN agent_type SET DEFAULT 'agent';

-- ---------------------------------------------------------------------------
-- 7. Add Phase 4 integrity columns on internal_agents.
--
--    These are part of the server-side workflow integrity / semantic-validator
--    flow from the implementation plan. They are added here (Phase 1b)
--    because the migration cadence lets us avoid a second DDL-heavy migration
--    when Phase 4 ships. Phase 4 code starts writing them; pre-Phase-4 code
--    ignores them.
-- ---------------------------------------------------------------------------
ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS workflow_steps_hash TEXT;

COMMENT ON COLUMN internal_agents.reviewed_at IS 'Timestamp when workflow agent was semantically validated and pinned. NULL for agent-type agents.';
COMMENT ON COLUMN internal_agents.reviewed_by IS 'Identity of the reviewer (system:<model-id> for LLM semantic validation). NULL for agent-type agents.';
COMMENT ON COLUMN internal_agents.workflow_steps_hash IS 'sha256 of canonicalized workflowSteps pinned at validation. Execution-time tamper check compares against this.';

-- ---------------------------------------------------------------------------
-- 8. Update column documentation to reflect the new taxonomy.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN internal_agents.agent_type IS 'Agent execution model: ''agent'' (dynamic LLM loop) or ''workflow'' (predetermined step graph). Legacy {A,B,C} values are migrated 1:1 (A,B -> agent; C -> workflow).';
COMMENT ON COLUMN internal_agent_versions.agent_type IS 'Agent execution model at version snapshot time. See internal_agents.agent_type for canonical values.';

COMMIT;
