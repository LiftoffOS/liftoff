-- Migration 167: Add per-agent autonomy override
-- Allows internal agents to override the workspace-level autonomy setting.
-- NULL = no override, use workspace setting.

ALTER TABLE internal_agents
  ADD COLUMN autonomy_override VARCHAR(20) NULL
    CHECK (autonomy_override IN ('autonomous', 'balanced', 'controlled'));

-- Version snapshots must capture autonomy_override so rollback can restore it.
ALTER TABLE internal_agent_versions
  ADD COLUMN autonomy_override VARCHAR(20) NULL
    CHECK (autonomy_override IN ('autonomous', 'balanced', 'controlled'));
