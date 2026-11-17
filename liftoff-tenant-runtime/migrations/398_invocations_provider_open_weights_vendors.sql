-- 398: admit 'qwen', 'deepseek' and 'kimi' as invocations.provider values.
--
-- Each became its own execution provider in VENDORS, so a run on one resolves
-- that name and the invocation-row insert fails before the adapter starts:
--   new row for relation "invocations" violates check constraint "chk_invocations_provider"
--
-- The rule this keeps tripping over: the constraint is a hand-written copy of
-- the provider union, in a place the type system cannot reach, so it has to be
-- widened in the SAME change that adds a provider. It has now been missed once
-- per provider added — 310 for 'openrouter', 391 for 'xai', this one for three
-- at once — which is why the comparison against RESOLVED_PROVIDERS lives in
-- `scripts/__tests__/invocations-provider-constraint.test.ts` and fails CI
-- rather than a live run. That test is what caught this.
--
-- The engine constraints need nothing: all three resolve to
-- 'openrouter-openai-wire', which is already admitted.

ALTER TABLE invocations DROP CONSTRAINT IF EXISTS chk_invocations_provider;
ALTER TABLE invocations ADD CONSTRAINT chk_invocations_provider
  CHECK (provider IN ('anthropic', 'anthropic-vertex', 'google', 'openai', 'openrouter', 'xai', 'qwen', 'deepseek', 'kimi'));

COMMENT ON COLUMN invocations.provider IS 'LLM provider used for this invocation (anthropic, anthropic-vertex, google, openai, openrouter, xai, qwen, deepseek, kimi).';
