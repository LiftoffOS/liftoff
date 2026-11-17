-- 222_backfill_integration_permission_types.sql
--
-- Backfill IntegrationPermission.type on every row in internal_agents.integrations.
--
-- Before this migration, the `type` field was optional and many older rows
-- have no `type` populated. Post-migration, the platform enforces that every
-- permission carries `type` and the enrichment path throws on any row that
-- still lacks one.
--
-- For each integration permission:
--   - If `id` matches an existing connectors row → set `type = connectors.type`.
--   - If `id` does not match any current connector (orphaned binding) → drop
--     the binding AND log to `migration_orphans` for review.
--   - Existing `type` values (e.g. 'external_agent', 'internal_agent', or
--     connector type already set) are preserved as-is.

BEGIN;

CREATE TABLE IF NOT EXISTS migration_orphans (
  id              SERIAL PRIMARY KEY,
  migration_name  TEXT NOT NULL,
  tenant_id       UUID NOT NULL,
  internal_agent_id UUID NOT NULL,
  integration_id  TEXT NOT NULL,
  permission      JSONB NOT NULL,
  reason          TEXT NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  agent_row RECORD;
  perm JSONB;
  new_perms JSONB;
  resolved_type TEXT;
  orphan_dropped BOOLEAN;
BEGIN
  FOR agent_row IN
    SELECT id, tenant_id, integrations
    FROM internal_agents
    WHERE deleted_at IS NULL
      AND integrations IS NOT NULL
      AND jsonb_typeof(integrations) = 'array'
      AND jsonb_array_length(integrations) > 0
  LOOP
    new_perms := '[]'::jsonb;
    orphan_dropped := FALSE;

    FOR perm IN SELECT * FROM jsonb_array_elements(agent_row.integrations) LOOP
      -- If type already set, keep as-is.
      IF perm ? 'type' AND perm->>'type' IS NOT NULL AND perm->>'type' <> '' THEN
        new_perms := new_perms || jsonb_build_array(perm);
        CONTINUE;
      END IF;

      resolved_type := NULL;

      -- Try connectors first (live + soft-deleted).
      SELECT type INTO resolved_type
      FROM connectors
      WHERE tenant_id = agent_row.tenant_id
        AND id::text = perm->>'id'
      LIMIT 1;

      IF resolved_type IS NOT NULL THEN
        new_perms := new_perms || jsonb_build_array(perm || jsonb_build_object('type', resolved_type));
        CONTINUE;
      END IF;

      -- Try external_agents.
      IF EXISTS (
        SELECT 1 FROM external_agents
        WHERE tenant_id = agent_row.tenant_id
          AND id::text = perm->>'id'
      ) THEN
        new_perms := new_perms || jsonb_build_array(perm || jsonb_build_object('type', 'external_agent'));
        CONTINUE;
      END IF;

      -- Try internal_agents (peer agents).
      IF EXISTS (
        SELECT 1 FROM internal_agents
        WHERE tenant_id = agent_row.tenant_id
          AND id::text = perm->>'id'
          AND deleted_at IS NULL
      ) THEN
        new_perms := new_perms || jsonb_build_array(perm || jsonb_build_object('type', 'internal_agent'));
        CONTINUE;
      END IF;

      -- Orphan: log and drop.
      INSERT INTO migration_orphans (
        migration_name, tenant_id, internal_agent_id, integration_id, permission, reason
      ) VALUES (
        '222_backfill_integration_permission_types',
        agent_row.tenant_id,
        agent_row.id,
        perm->>'id',
        perm,
        'no matching connector / external_agent / internal_agent for id'
      );
      orphan_dropped := TRUE;
    END LOOP;

    -- Write the updated JSONB array back. Bump current_version so the
    -- runtime treats the new shape as a fresh snapshot. Also insert a
    -- matching internal_agent_versions row so versions table stays
    -- in lock-step with internal_agents.current_version — readers that
    -- pull the latest version (rollback UI, audit, reconciler) must see
    -- the typed `integrations` array, not the pre-migration shape.
    IF new_perms IS DISTINCT FROM agent_row.integrations OR orphan_dropped THEN
      UPDATE internal_agents
      SET integrations = new_perms,
          current_version = COALESCE(current_version, 1) + 1,
          updated_at = NOW()
      WHERE id = agent_row.id;

      -- engine_config column dropped from internal_agents at migration 265.
      -- internal_agent_versions still carries the column for audit; backfilled
      -- rows leave it NULL since the source row no longer has the value.
      INSERT INTO internal_agent_versions (
        internal_agent_id, version, role, responsibilities, integrations,
        additional_context, system_prompt, user_instructions, source, created_by,
        agent_type, model_config, memory_scope, exec_config, workflow_steps,
        trigger_config, delegates, instructions_md, instructions,
        workflow_visualization_steps, autonomy_override
      )
      SELECT
        ia.id, ia.current_version, ia.role, ia.responsibilities, ia.integrations,
        ia.additional_context, ia.system_prompt, ia.user_instructions, 'manual', NULL,
        ia.agent_type, ia.model_config, ia.memory_scope, ia.exec_config, ia.workflow_steps,
        ia.trigger_config, ia.delegates, ia.instructions_md, ia.instructions,
        ia.workflow_visualization_steps, ia.autonomy_override
      FROM internal_agents ia
      WHERE ia.id = agent_row.id
      ON CONFLICT (internal_agent_id, version) DO NOTHING;
    END IF;
  END LOOP;
END $$;


-- Verification — should return zero rows.
DO $$
DECLARE
  bad_count INT;
BEGIN
  SELECT count(*) INTO bad_count
  FROM internal_agents
  WHERE deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(integrations) p
      WHERE p->>'type' IS NULL OR p->>'type' = ''
    );
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Backfill incomplete: % internal_agents still have untyped permissions',
      bad_count;
  END IF;
END $$;

COMMIT;
