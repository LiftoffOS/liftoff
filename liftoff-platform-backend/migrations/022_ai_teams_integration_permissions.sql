-- Migrate integrations column from simple ID array to rich permission objects
-- Old format: ["salesforce", "slack"]
-- New format: [{"id": "salesforce", "selectedObjects": ["Leads", "Contacts"]}, {"id": "slack", "selectedObjects": []}]
-- Empty selectedObjects array means full access to all objects

-- Add comment documenting the structure
COMMENT ON COLUMN ai_teams.integrations IS 'JSONB array of integration permissions. Each element: {id: string, selectedObjects: string[]}. Empty selectedObjects means full access.';

-- Ensure null values become empty arrays
UPDATE ai_teams
SET integrations = '[]'::jsonb
WHERE integrations IS NULL;

-- Set NOT NULL constraint now that all nulls are handled
ALTER TABLE ai_teams
ALTER COLUMN integrations SET NOT NULL,
ALTER COLUMN integrations SET DEFAULT '[]'::jsonb;

-- Migrate existing string arrays to object arrays
-- Wraps each string ID in an object with empty selectedObjects (full access)
UPDATE ai_teams
SET integrations = (
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', elem::text,
        'selectedObjects', '[]'::jsonb
      )
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements_text(integrations) AS elem
)
WHERE jsonb_typeof(integrations) = 'array'
  AND jsonb_array_length(integrations) > 0
  AND jsonb_typeof(integrations->0) = 'string';
