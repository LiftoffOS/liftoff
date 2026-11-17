-- Remove duplicate connector manifests for the same connector_type per tenant.
-- When a connector is reconnected, a new manifest is created with the canonical
-- alias (e.g., "google-sheets") while the old one (e.g., "sheets") persists.
-- Keep only the most recently updated manifest per (tenant_id, connector_type).
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
