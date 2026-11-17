-- Drop the engine_config column from internal_agents.
--
-- Adapter selection is purely a function of resolved provider; the column
-- is no longer a routing concept. The runtime dispatch (TR
-- agent-execution/service.ts) flows every agent through the hybrid loop,
-- which calls a VendorSdkAdapter selected from provider — engine_config
-- is read nowhere.

-- Safety: log if any internal_agent_versions row still carries a
-- non-empty engine_config (audit-only column on the versions table, kept
-- after this drop for historical record).
DO $$
DECLARE
  ref_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO ref_count
  FROM internal_agent_versions
  WHERE engine_config IS NOT NULL AND engine_config <> '{}'::jsonb;
  IF ref_count > 0 THEN
    RAISE NOTICE 'engine_config column drop: % internal_agent_versions rows still carry the field (audit only, kept on versions table)', ref_count;
  END IF;
END $$;

ALTER TABLE internal_agents DROP COLUMN IF EXISTS engine_config;

-- Note: internal_agent_versions.engine_config is preserved for audit
-- (historical record of past routing decisions on per-version snapshots).
-- A follow-up migration can drop it if the audit value is also unwanted.
