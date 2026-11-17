-- Fix ALL stale agent data in one pass.
-- This covers trigger_config, integrations, and any other fields
-- that have incorrect values from the original distillation or
-- pre-migration state.

-- 1. Fix trigger_config: */5 → */1 for all cron agents
UPDATE internal_agents
SET trigger_config = jsonb_set(trigger_config, '{cronExpr}', '"*/1 * * * *"')
WHERE trigger_config->>'cronExpr' = '*/5 * * * *'
  AND trigger_config->>'type' = 'cron'
  AND deleted_at IS NULL;

-- 2. Fix integrations: resolve any remaining non-UUID integration IDs
-- (Migration 068 should have done this, but run again as safety net)
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

UPDATE internal_agents ia
SET integrations = (
  SELECT jsonb_agg(
    CASE
      WHEN elem->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN elem
      ELSE COALESCE(
        (SELECT jsonb_set(elem, '{id}', to_jsonb(c.id::text))
         FROM alias_to_type att
         JOIN connectors c ON c.type = att.connector_type
           AND c.tenant_id = ia.tenant_id AND c.status = 'active'
         WHERE att.alias = elem->>'id'
         ORDER BY c.created_at DESC LIMIT 1),
        elem
      )
    END
  )
  FROM jsonb_array_elements(ia.integrations) elem
)
WHERE ia.deleted_at IS NULL
  AND ia.integrations IS NOT NULL
  AND ia.integrations != '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(ia.integrations) e
    WHERE e->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

DROP TABLE alias_to_type;
