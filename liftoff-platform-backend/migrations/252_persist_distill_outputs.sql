-- internal_agents: skills (semantic instruction modules) and capability_tier
-- (replaces the substring heuristic in event-payload.ts).
ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS capability_tier VARCHAR(32) NOT NULL DEFAULT 'connector_only';

ALTER TABLE internal_agent_versions
  ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS capability_tier VARCHAR(32) NOT NULL DEFAULT 'connector_only';

-- One-time seed for capability_tier on every internal_agents row using the
-- same substring heuristic the runtime currently applies in event-payload.ts.
-- After this migration the heuristic in event-payload.ts is removed; the
-- column is the source of truth going forward.
UPDATE internal_agents
   SET capability_tier = 'execution_enabled'
 WHERE capability_tier = 'connector_only'
   AND (
     COALESCE(system_prompt, '') LIKE '%sandbox__%' OR
     COALESCE(user_instructions, '') LIKE '%sandbox__%' OR
     COALESCE(instructions_md, '') LIKE '%sandbox__%'
   );

-- Seed capability_tier on EVERY internal_agent_versions row using each row's
-- own snapshotted system_prompt / user_instructions / instructions_md — NOT
-- the latest-only join. Rollback to an older version restores the correct
-- capability_tier even if it differed from the current row.
UPDATE internal_agent_versions
   SET capability_tier = 'execution_enabled'
 WHERE capability_tier = 'connector_only'
   AND (
     COALESCE(system_prompt, '') LIKE '%sandbox__%' OR
     COALESCE(user_instructions, '') LIKE '%sandbox__%' OR
     COALESCE(instructions_md, '') LIKE '%sandbox__%'
   );

-- No integration_configs column. Per-binding scoping (gmailQuery / outlookFilter
-- / sendAs) lives on IntegrationPermission.config in the existing `integrations`
-- JSONB column. Redistill-service merges distill's integrationConfigs into the
-- agent's integrations array before calling service.update (see plan §2 Group B).
--
-- No push_high_risk_allowed column. The R5 workspace-tools subsystem that
-- consumed it is dead code; §0 removes it from the runtime in the same release.
