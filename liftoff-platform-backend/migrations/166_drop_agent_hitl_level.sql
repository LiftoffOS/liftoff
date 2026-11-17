-- Drop hitl_level from internal_agents and internal_agent_versions.
-- HITL is governed entirely by workspace oversight settings (autonomy/escalation/
-- sensitiveWork/communication). Per-agent overrides were never shipped and the
-- concept doesn't map to those controls.

ALTER TABLE internal_agents DROP COLUMN IF EXISTS hitl_level;
ALTER TABLE internal_agent_versions DROP COLUMN IF EXISTS hitl_level;
