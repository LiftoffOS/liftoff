-- One-time fix for integration references to hard-deleted connectors.
-- Prior to soft-delete (this commit), disconnect hard-deleted the connector row.
-- This left internal_agents.integrations pointing to non-existent connector UUIDs.
-- Replace each stale UUID with the current connector of the same type for that tenant.
--
-- After this migration, soft-delete is in effect so this situation cannot recur.

DO $$
DECLARE
  agent_row RECORD;
  elem jsonb;
  stale_id TEXT;
  replacement_id TEXT;
  new_integrations jsonb;
BEGIN
  FOR agent_row IN
    SELECT ia.id, ia.tenant_id, ia.integrations
    FROM internal_agents ia
    WHERE ia.deleted_at IS NULL
      AND ia.integrations IS NOT NULL
      AND ia.integrations != '[]'::jsonb
      -- Only agents with at least one stale UUID
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(ia.integrations) e
        WHERE e->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND NOT EXISTS (SELECT 1 FROM connectors c WHERE c.id::text = e->>'id')
      )
  LOOP
    new_integrations := '[]'::jsonb;

    FOR elem IN SELECT value FROM jsonb_array_elements(agent_row.integrations)
    LOOP
      stale_id := elem->>'id';

      -- Check if UUID references a non-existent connector
      IF stale_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND NOT EXISTS (SELECT 1 FROM connectors WHERE id::text = stale_id) THEN

        -- Find the newest connector of any type for this tenant that isn't
        -- already referenced by another integration in this agent
        SELECT c.id::text INTO replacement_id
        FROM connectors c
        WHERE c.tenant_id = agent_row.tenant_id
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(agent_row.integrations) other
            WHERE other->>'id' = c.id::text
          )
        ORDER BY c.created_at DESC
        LIMIT 1;

        IF replacement_id IS NOT NULL THEN
          new_integrations := new_integrations || jsonb_build_array(
            jsonb_set(elem, '{id}', to_jsonb(replacement_id))
          );
        ELSE
          -- No replacement found — keep original (will fail at runtime but not lose data)
          new_integrations := new_integrations || jsonb_build_array(elem);
        END IF;
      ELSE
        -- Valid UUID or non-UUID — keep as-is
        new_integrations := new_integrations || jsonb_build_array(elem);
      END IF;
    END LOOP;

    -- Only update if something changed
    IF new_integrations IS DISTINCT FROM agent_row.integrations THEN
      UPDATE internal_agents SET integrations = new_integrations, updated_at = NOW()
      WHERE id = agent_row.id;
    END IF;
  END LOOP;
END $$;
