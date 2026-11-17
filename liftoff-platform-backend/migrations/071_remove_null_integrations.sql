-- Fix null entries in internal_agents.integrations introduced by migration 068.
-- When an alias could not be resolved to an active connector, the CASE ELSE
-- returned NULL which jsonb_agg() included in the array.
-- This migration strips those nulls and any remaining unresolved aliases.

-- Step 1: Remove null entries from integrations arrays
UPDATE internal_agents
SET integrations = (
  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
  FROM jsonb_array_elements(integrations) elem
  WHERE elem IS NOT NULL
    AND elem->>'id' IS NOT NULL
)
WHERE deleted_at IS NULL
  AND integrations IS NOT NULL
  AND integrations != '[]'::jsonb
  AND (
    integrations @> '[null]'::jsonb
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(integrations) e
      WHERE e IS NULL OR e->>'id' IS NULL
    )
  );

-- Step 2: Remove any remaining non-UUID integration entries (unresolved aliases).
-- These are stale references to connectors that no longer exist.
UPDATE internal_agents
SET integrations = (
  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
  FROM jsonb_array_elements(integrations) elem
  WHERE elem->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
WHERE deleted_at IS NULL
  AND integrations IS NOT NULL
  AND integrations != '[]'::jsonb
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(integrations) e
    WHERE e->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
