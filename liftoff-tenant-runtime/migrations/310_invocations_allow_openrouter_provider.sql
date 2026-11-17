-- 310: allow 'openrouter' as an invocations.provider value.
--
-- The openrouter agent engine (opencode SDK — open-weights GLM/Llama/DeepSeek/Qwen
-- models) is a first-class provider in the LLMProvider type (src/llm/types.ts),
-- but migration 045's chk_invocations_provider CHECK predates it and only admits
-- ('anthropic','anthropic-vertex','google','openai'). So the invocation-row insert
-- for any openrouter run fails with:
--   new row for relation "invocations" violates check constraint "chk_invocations_provider"
-- before the adapter even starts. Widen the constraint to match the type.

ALTER TABLE invocations DROP CONSTRAINT IF EXISTS chk_invocations_provider;
ALTER TABLE invocations ADD CONSTRAINT chk_invocations_provider
  CHECK (provider IN ('anthropic', 'anthropic-vertex', 'google', 'openai', 'openrouter'));

COMMENT ON COLUMN invocations.provider IS 'LLM provider used for this invocation (anthropic, anthropic-vertex, google, openai, openrouter).';
