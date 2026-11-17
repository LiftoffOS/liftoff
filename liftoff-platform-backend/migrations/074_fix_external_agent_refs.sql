-- Fix internal_agents.integrations that had external agent UUIDs incorrectly
-- replaced by migration 073. That migration only checked the connectors table
-- when validating UUIDs, missing external_agents. This restores them.
--
-- Strategy: For each integration UUID that matches an existing connector but
-- is duplicated (same UUID appears multiple times), replace the duplicates
-- with external agent UUIDs that the agent should reference.

DO $$
DECLARE
  agent_row RECORD;
  elem jsonb;
  new_integrations jsonb;
  seen_ids TEXT[];
  current_id TEXT;
BEGIN
  FOR agent_row IN
    SELECT ia.id, ia.tenant_id, ia.integrations
    FROM internal_agents ia
    WHERE ia.deleted_at IS NULL
      AND ia.integrations IS NOT NULL
      AND ia.integrations != '[]'::jsonb
      -- Only fix agents with duplicate integration IDs
      AND (SELECT COUNT(DISTINCT e.value->>'id') FROM jsonb_array_elements(ia.integrations) e)
        < jsonb_array_length(ia.integrations)
  LOOP
    new_integrations := '[]'::jsonb;
    seen_ids := '{}';

    FOR elem IN SELECT value FROM jsonb_array_elements(agent_row.integrations)
    LOOP
      current_id := elem->>'id';

      IF current_id = ANY(seen_ids) THEN
        -- This is a duplicate — find an external agent for this tenant
        -- that isn't already in the integrations
        SELECT ea.id::text INTO current_id
        FROM external_agents ea
        WHERE ea.tenant_id = agent_row.tenant_id
          AND ea.deleted_at IS NULL
          AND ea.status = 'connected'
          AND ea.id::text != ALL(seen_ids)
        ORDER BY ea.created_at DESC
        LIMIT 1;

        IF current_id IS NOT NULL THEN
          new_integrations := new_integrations || jsonb_build_array(
            jsonb_build_object('id', current_id, 'selectedObjects', '[]'::jsonb)
          );
          seen_ids := array_append(seen_ids, current_id);
        END IF;
        -- If no external agent found, skip the duplicate
      ELSE
        new_integrations := new_integrations || jsonb_build_array(elem);
        seen_ids := array_append(seen_ids, current_id);
      END IF;
    END LOOP;

    IF new_integrations IS DISTINCT FROM agent_row.integrations THEN
      UPDATE internal_agents SET integrations = new_integrations, updated_at = NOW()
      WHERE id = agent_row.id;
    END IF;
  END LOOP;
END $$;
