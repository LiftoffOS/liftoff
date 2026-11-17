-- Resolve legacy integration aliases (e.g., "sheets") to connector UUIDs.
-- The frontend used to send static aliases from integrations.json as integration IDs.
-- The backend now resolves these on create/update, but existing agents have stale aliases.
-- This migration fixes all existing agents by looking up the connected connector UUID
-- for each alias-based integration.

-- Mapping of frontend aliases to connector types
CREATE TEMPORARY TABLE alias_to_type (alias TEXT PRIMARY KEY, connector_type TEXT NOT NULL);
INSERT INTO alias_to_type VALUES
  ('gmail', 'google_mail'), ('mail', 'google_mail'),
  ('calendar', 'google_calendar'),
  ('docs', 'google_docs'),
  ('drive', 'google_drive'),
  ('sheets', 'google_sheets'),
  ('slides', 'google_slides'),
  ('slack', 'slack'),
  ('github', 'github'),
  ('salesforce', 'salesforce'),
  ('outlook', 'microsoft_outlook_mail'), ('outlook-mail', 'microsoft_outlook_mail'),
  ('outlook-calendar', 'microsoft_outlook_calendar'),
  ('teams', 'microsoft_teams'),
  ('todo', 'microsoft_todo'),
  ('contacts', 'microsoft_contacts'),
  ('onenote', 'microsoft_onenote'),
  ('sharepoint', 'microsoft_sharepoint'),
  ('planner', 'microsoft_planner'),
  ('onedrive', 'microsoft_onedrive'),
  ('dropbox', 'dropbox'),
  ('box', 'box');

-- For each internal_agent, replace alias-based integration IDs with connector UUIDs.
-- Only touches integrations where the ID is NOT already a UUID.
UPDATE internal_agents ia
SET integrations = (
  SELECT jsonb_agg(
    CASE
      -- If the integration ID is already a UUID, keep it
      WHEN elem->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN elem
      -- Otherwise, look up the connector UUID by type
      ELSE (
        SELECT jsonb_set(elem, '{id}', to_jsonb(c.id::text))
        FROM alias_to_type att
        JOIN connectors c ON c.type = att.connector_type
          AND c.tenant_id = ia.tenant_id
          AND c.status = 'active'
        WHERE att.alias = elem->>'id'
        ORDER BY c.created_at DESC
        LIMIT 1
      )
    END
  )
  FROM jsonb_array_elements(ia.integrations) elem
)
WHERE ia.deleted_at IS NULL
  AND ia.integrations IS NOT NULL
  AND ia.integrations != '[]'::jsonb
  -- Only update agents that have at least one non-UUID integration ID
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(ia.integrations) e
    WHERE e->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

DROP TABLE alias_to_type;
