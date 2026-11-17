-- WS-5.1
--
-- Preserves the original "bad" integration elements (non-UUID id values,
-- references to deleted connector instances, etc.) when WS-5.1's backfill
-- removes them from the live `integrations` column. Ops can inspect this
-- column to decide whether to manually re-bind a tenant's missing integration.

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS integrations_quarantine JSONB;

COMMENT ON COLUMN internal_agents.integrations_quarantine IS
  'Integration elements removed from `integrations` because the id was '
  'not a UUID or did not resolve to an active connector_instance. Ops-only.';
