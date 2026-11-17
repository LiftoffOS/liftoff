-- Migration 197: Default all internal_agents to tier='medium'
--
-- Every agent runs at tier=medium. Strip vendor-specific overrides
-- (modelId/provider) so the tier policy is the authoritative resolver.
-- Snapshot tables preserve pre-migration state for rollback within the soak
-- window; dropped in a follow-up after stability is confirmed.

BEGIN;

CREATE TABLE internal_agents_modelconfig_pre_197 AS
  SELECT id, tenant_id, model_config, NOW() AS snapshot_at FROM internal_agents;
CREATE TABLE internal_agent_versions_modelconfig_pre_197 AS
  SELECT id, internal_agent_id, model_config, NOW() AS snapshot_at FROM internal_agent_versions;

UPDATE internal_agents
SET model_config = (
  COALESCE(model_config, '{}'::jsonb) - 'modelId' - 'model_id' - 'provider'
) || '{"tier": "medium"}'::jsonb;

UPDATE internal_agent_versions
SET model_config = (
  COALESCE(model_config, '{}'::jsonb) - 'modelId' - 'model_id' - 'provider'
) || '{"tier": "medium"}'::jsonb;

COMMIT;
