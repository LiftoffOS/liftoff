-- 321: invocations.execution_engine — concrete outer-agent engine provenance.
--
-- provider ∈ (anthropic, anthropic-vertex, google, openai, openrouter) cannot
-- distinguish the CONCRETE engine that ran a row: openai → OpenAI-Agents SDK OR
-- Codex SDK; google → Gemini GenAI OR ADK; openrouter → OpenAI-wire OR OpenCode,
-- selected by the OPENAI_ENGINE / GOOGLE_ENGINE / OPENROUTER_ENGINE deploy flags.
-- execution_engine records which one, resolved deterministically at row creation
-- (resolveExecutionEngine, src/agent-execution/adapter/engine-resolver.ts) BEFORE
-- execution begins, so it is present for success/error/paused/admission-denied
-- alike. See plan Workstream A.
--
-- Additive / nullable: pre-321 rows stay NULL. They are NOT backfilled —
-- inferring an engine from the current deploy env would fabricate provenance
--. The 'unknown-legacy' value is admitted by the CHECK for the
-- eventual historical backfill (Stage 5); no row is written it here.
--
-- The CHECK is added NOT VALID: it enforces on every new INSERT/UPDATE but skips
-- the validating scan of existing rows. Existing rows are all NULL (CHECK allows
-- NULL), so validation would be trivially true, but a validating ADD CONSTRAINT
-- on an RLS-FORCED table can behave differently on Cloud SQL than in CI — NOT
-- VALID sidesteps that class of migration trap and the full-table scan.
--
-- No standalone index: execution_engine is low-cardinality (≤8 values) and no
-- query or dashboard filters on it yet. Add one only with a real
-- consumer.

ALTER TABLE invocations ADD COLUMN IF NOT EXISTS execution_engine TEXT;

ALTER TABLE invocations DROP CONSTRAINT IF EXISTS chk_invocations_execution_engine;
ALTER TABLE invocations ADD CONSTRAINT chk_invocations_execution_engine
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

COMMENT ON COLUMN invocations.execution_engine IS
  'Concrete outer-agent engine that executed this invocation (resolveExecutionEngine at creation): claude-agent-sdk | openai-agents | openai-codex | google-genai | google-adk | openrouter-openai-wire | opencode. NULL for pre-321 rows (not backfilled); ''unknown-legacy'' reserved for a future historical backfill. Bounded, low-cardinality; not indexed.';
