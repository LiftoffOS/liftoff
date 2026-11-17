-- Per-agent CLAUDE.md project instructions for Claude Agent SDK loading.
--
-- Phase 1 of the CLAUDE.md rollout. Each layer holds markdown that the
-- tenant runtime materializes into a per-invocation working directory as
-- `CLAUDE.md`. The backend merges the three layers (tenant -> workforce plan
-- -> agent) into a single effective string at Pub/Sub event publish time and
-- ships it to the tenant runtime as `instructionsMd`. The runtime stays dumb
-- about the hierarchy.
--
-- All columns nullable with no default so existing rows continue to publish
-- `instructionsMd: null` until an operator opts in per tenant/plan/agent.

ALTER TABLE internal_agents         ADD COLUMN IF NOT EXISTS instructions_md TEXT;
ALTER TABLE internal_agent_versions ADD COLUMN IF NOT EXISTS instructions_md TEXT;
ALTER TABLE workforce_plans         ADD COLUMN IF NOT EXISTS instructions_md TEXT;
ALTER TABLE tenants                 ADD COLUMN IF NOT EXISTS agent_instructions_md TEXT;

COMMENT ON COLUMN internal_agents.instructions_md
  IS 'Agent-level CLAUDE.md markdown loaded by the Claude Agent SDK via settingSources: [project] + claude_code preset. Merged with tenant + workforce-plan layers at event-publish time.';
COMMENT ON COLUMN internal_agent_versions.instructions_md
  IS 'Version snapshot of internal_agents.instructions_md for audit / rollback.';
COMMENT ON COLUMN workforce_plans.instructions_md
  IS 'Workforce-plan-level CLAUDE.md markdown applied to every internal_agent provisioned under this plan.';
COMMENT ON COLUMN tenants.agent_instructions_md
  IS 'Tenant-level CLAUDE.md markdown applied to every internal_agent in this tenant (highest level of the three-layer merge).';
