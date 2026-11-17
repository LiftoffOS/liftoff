-- Supersede compiled instructions that have non-UUID integration IDs (e.g., "sheets").
-- These were created before migration 068 resolved aliases on the platform backend.
-- Next agent activation will create a new instruction with resolved UUIDs.
UPDATE compiled_instructions
SET status = 'superseded', activated_at = NULL, updated_at = NOW()
WHERE status = 'active'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(integrations) elem
    WHERE elem->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
