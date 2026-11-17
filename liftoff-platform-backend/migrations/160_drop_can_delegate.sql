-- Migration 153: Remove can_delegate from person_agent_assignments
-- Any authenticated tenant member's Claude Code key can delegate to any active
-- internal agent. The agent's HITL/oversight settings are the access control boundary.
-- A per-user per-agent grant flag is redundant and creates admin friction with no
-- real security benefit.

ALTER TABLE person_agent_assignments
  DROP COLUMN IF EXISTS can_delegate;
