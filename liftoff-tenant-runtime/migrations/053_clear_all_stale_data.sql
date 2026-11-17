-- Clear ALL stale data in the tenant runtime database in one pass.
-- After this migration, only clean, current data remains.

-- 1. Fix agents trigger_config: */5 → */1 for cron agents
UPDATE agents
SET trigger_config = jsonb_set(trigger_config, '{cronExpr}', '"*/1 * * * *"')
WHERE trigger_config->>'cronExpr' = '*/5 * * * *'
  AND trigger_config->>'type' = 'cron';

-- 2. Supersede ALL active compiled instructions that have non-UUID integration IDs
UPDATE compiled_instructions
SET status = 'superseded', activated_at = NULL, updated_at = NOW()
WHERE status = 'active'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(integrations) elem
    WHERE elem->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- 3. Remove ALL duplicate connector manifests per (tenant_id, connector_type).
--    Keep only the most recently updated one.
DELETE FROM connector_manifests m
USING (
  SELECT DISTINCT ON (tenant_id, connector_type)
    id, tenant_id, connector_type
  FROM connector_manifests
  ORDER BY tenant_id, connector_type, updated_at DESC
) keep
WHERE m.tenant_id = keep.tenant_id
  AND m.connector_type = keep.connector_type
  AND m.id != keep.id;

-- 4. Clear any stuck event_processing_ledger entries from prior failed attempts
UPDATE event_processing_ledger
SET status = 'failed', error = 'Cleared by migration 053', updated_at = NOW()
WHERE status = 'processing'
  AND updated_at < NOW() - INTERVAL '5 minutes';
