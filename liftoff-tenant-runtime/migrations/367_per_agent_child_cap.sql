-- 367_per_agent_child_cap
-- Per-(tenant, agent) cap on concurrently-running delegated children.
--
-- Distinct from default_max_concurrent_children, which bounds how many
-- children ONE fan-out call runs at once. This bounds how many delegated runs
-- of ONE agent may be in flight across every caller in the workspace, which is
-- the number that matters once single-target delegation and the per-teammate
-- hand-off tools are governed: neither goes through a fan-out, so the fan-out
-- knob never sees them.
--
-- Delegated children bypass the per-agent execution lock deliberately (taking
-- it would serialise a fan-out to one specialist and deadlock self-delegation),
-- so this cap is the bound that replaces it. NULL = use the in-code default
-- (DELEGATION_DEFAULTS.PER_AGENT_CHILDREN, 3); clamped by the hard cap in code
-- like every other knob in this table.

ALTER TABLE tenant_runtime_config
  ADD COLUMN IF NOT EXISTS max_children_per_agent int;

-- A delegated child can now pause for a human approval (it runs with its own
-- HITL level rather than the hardcoded 5 that made pausing impossible), and the
-- registry needs to say so. 'paused' is deliberately not 'running' — a child
-- waiting up to 24h on an approval must not hold a capacity slot against the
-- per-agent cap above — and deliberately not 'completed', which would read as
-- an answer that never arrived.
ALTER TABLE delegation_active DROP CONSTRAINT IF EXISTS delegation_active_status_check;
ALTER TABLE delegation_active ADD CONSTRAINT delegation_active_status_check
  CHECK (status IN ('running', 'completed', 'failed', 'interrupted', 'timeout', 'paused'));
