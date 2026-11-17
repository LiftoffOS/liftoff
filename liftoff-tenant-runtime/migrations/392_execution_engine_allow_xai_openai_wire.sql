-- 392: allow 'xai-openai-wire' as an execution_engine value, on both tables.
--
-- Migrations 321 and 322 wrote the engine list into CHECK constraints on
-- `invocations` and `agent_trajectories`. `xai-openai-wire` was added to
-- ExecutionEngineId when Grok became its own engine and neither constraint
-- followed.
--
-- Unlike the provider constraint (migration 391), this one did not fail the run
-- — the column is nullable, so a Grok invocation recorded NULL and read back as
-- `unknown-legacy`, the sentinel documented as "never produced by resolution".
-- A run with no provenance still succeeds, bills and returns, which is why this
-- surfaced as a wrong value in a log rather than as an error.
--
-- Both tables are widened together: they carry the same list for the same
-- reason, and widening one leaves a trajectory that cannot describe the
-- invocation it belongs to.
-- `scripts/__tests__/invocations-provider-constraint.test.ts` now compares both
-- lists against EXECUTION_ENGINE_IDS so the next engine fails in CI.

ALTER TABLE invocations DROP CONSTRAINT IF EXISTS chk_invocations_execution_engine;
ALTER TABLE invocations ADD CONSTRAINT chk_invocations_execution_engine
  CHECK (execution_engine IS NULL OR execution_engine IN (
    'claude-agent-sdk',
    'openai-agents',
    'openai-codex',
    'google-genai',
    'google-adk',
    'openrouter-openai-wire',
    'xai-openai-wire',
    'opencode',
    'unknown-legacy'
)) NOT VALID;

ALTER TABLE agent_trajectories DROP CONSTRAINT IF EXISTS chk_agent_trajectories_execution_engine;
ALTER TABLE agent_trajectories ADD CONSTRAINT chk_agent_trajectories_execution_engine
  CHECK (execution_engine IS NULL OR execution_engine IN (
    'claude-agent-sdk',
    'openai-agents',
    'openai-codex',
    'google-genai',
    'google-adk',
    'openrouter-openai-wire',
    'xai-openai-wire',
    'opencode',
    'unknown-legacy'
)) NOT VALID;
