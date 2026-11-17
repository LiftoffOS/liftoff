-- 322: agent_trajectories.execution_engine + nested_engine — trajectory-level
-- engine provenance.
--
-- The trajectory index row already carries provider + model; these add the
-- CONCRETE engine so diagnostics can group trajectories by engine (openai →
-- OpenAI-Agents vs Codex, google → GenAI vs ADK, openrouter → OpenAI-wire vs
-- OpenCode). Mirrors invocations.execution_engine (migration 321).
--
-- execution_engine — outer-agent engine for a top-level run. NULL for nested
-- code_session rows (they use nested_engine) and pre-322 rows.
-- nested_engine — nested code_session specialist engine. NULL for top-level
-- rows. Kept separate so an outer OpenAI Codex engine is never conflated
-- with a nested Codex coding task (.1).
--
-- Additive/nullable, not backfilled. CHECKs added NOT VALID to avoid the
-- RLS-forced validating-scan trap on Cloud SQL (see migration 321). No index:
-- both columns are low-cardinality and no query filters on them yet.

ALTER TABLE agent_trajectories ADD COLUMN IF NOT EXISTS execution_engine TEXT;
ALTER TABLE agent_trajectories ADD COLUMN IF NOT EXISTS nested_engine TEXT;

ALTER TABLE agent_trajectories DROP CONSTRAINT IF EXISTS chk_agent_trajectories_execution_engine;
ALTER TABLE agent_trajectories ADD CONSTRAINT chk_agent_trajectories_execution_engine
  CHECK (execution_engine IS NULL OR execution_engine IN (
    'claude-agent-sdk',
    'openai-agents',
    'openai-codex',
    'google-genai',
    'google-adk',
    'openrouter-openai-wire',
    'opencode',
    'unknown-legacy'
)) NOT VALID;

ALTER TABLE agent_trajectories DROP CONSTRAINT IF EXISTS chk_agent_trajectories_nested_engine;
ALTER TABLE agent_trajectories ADD CONSTRAINT chk_agent_trajectories_nested_engine
  CHECK (nested_engine IS NULL OR nested_engine IN (
    'claude-code-session',
    'codex-code-session',
    'gemini-code-session',
    'opencode-code-session'
)) NOT VALID;

COMMENT ON COLUMN agent_trajectories.execution_engine IS
  'Concrete outer-agent engine for this trajectory (schema 1.1+, matches invocations.execution_engine). NULL for nested code_session rows and pre-322 rows.';
COMMENT ON COLUMN agent_trajectories.nested_engine IS
  'Nested code_session specialist engine (claude-code-session | codex-code-session | gemini-code-session | opencode-code-session). NULL for top-level rows. Never conflated with execution_engine.';
