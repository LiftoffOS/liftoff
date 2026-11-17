-- 405: allow 'google-gemini-cli' as an execution_engine value, on both tables.
--
-- Migrations 321 and 322 wrote the engine list into CHECK constraints on
-- `invocations` and `agent_trajectories`, and 392 widened them for
-- `xai-openai-wire`. `google-gemini-cli` — Gemini on the Gemini CLI, Google's
-- own agent runtime and now the default engine for provider `google` — is the
-- next id in ExecutionEngineId, and neither constraint knows it.
--
-- As with 392, a missing engine does not fail the run: the column is nullable,
-- so a Gemini invocation would record NULL and read back as `unknown-legacy`,
-- succeed, bill and return with no provenance. Both tables are widened together
-- for the same reason as before: a trajectory must be able to describe the
-- invocation it belongs to.
-- `scripts/__tests__/invocations-provider-constraint.test.ts` compares both
-- lists against the vendor record, so the next engine fails in CI.

ALTER TABLE invocations DROP CONSTRAINT IF EXISTS chk_invocations_execution_engine;
ALTER TABLE invocations ADD CONSTRAINT chk_invocations_execution_engine
  CHECK (execution_engine IS NULL OR execution_engine IN (
    'claude-agent-sdk',
    'openai-agents',
    'openai-codex',
    'google-genai',
    'google-adk',
    'google-gemini-cli',
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
    'google-gemini-cli',
    'openrouter-openai-wire',
    'xai-openai-wire',
    'opencode',
    'unknown-legacy'
)) NOT VALID;
