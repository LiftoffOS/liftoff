-- Link internal agents to the workforce plan they were provisioned from.
--
-- This enables the three-layer CLAUDE.md merge (tenant → plan → agent) in
-- buildEffectiveInstructionsMd(). The column is nullable: agents created
-- before workforce plans (or created manually) have no plan association.
--
-- The FK references workforce_plans(id) without ON DELETE CASCADE so that
-- deleting a plan does not cascade-delete its provisioned agents.

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS workforce_plan_id UUID REFERENCES workforce_plans(id);

CREATE INDEX IF NOT EXISTS idx_internal_agents_workforce_plan
  ON internal_agents(workforce_plan_id)
  WHERE workforce_plan_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN internal_agents.workforce_plan_id
  IS 'Optional FK to the workforce plan this agent was provisioned from. Used for three-layer CLAUDE.md merge (tenant → plan → agent).';
