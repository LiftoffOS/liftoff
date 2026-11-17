-- Migration 179: Fix missing autonomy_override column on internal_agent_versions
-- Migration 167 can be recorded as applied without its ALTER TABLE
-- internal_agent_versions statement having executed, leaving the column absent
-- while internal_agents already has it. createVersion references the column, so
-- its absence causes a 500 on every agent creation.

ALTER TABLE internal_agent_versions
  ADD COLUMN IF NOT EXISTS autonomy_override VARCHAR(20) NULL
    CHECK (autonomy_override IN ('autonomous', 'balanced', 'controlled'));
