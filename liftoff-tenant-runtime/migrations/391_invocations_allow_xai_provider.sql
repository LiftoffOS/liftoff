-- 391: allow 'xai' as an invocations.provider value.
--
-- Grok became its own execution provider, so a Grok run now resolves `xai` and
-- the invocation-row insert fails before the adapter starts:
--   new row for relation "invocations" violates check constraint "chk_invocations_provider"
--
-- This is the same failure migration 310 fixed for 'openrouter', which is the
-- point worth recording: the constraint is a hand-written copy of the provider
-- union, in a place the type system cannot reach, and it has now been missed
-- once per provider added. `scripts/__tests__/invocations-provider-constraint.test.ts`
-- compares this list against RESOLVED_PROVIDERS so the next one fails in CI
-- rather than in a live run.

ALTER TABLE invocations DROP CONSTRAINT IF EXISTS chk_invocations_provider;
ALTER TABLE invocations ADD CONSTRAINT chk_invocations_provider
  CHECK (provider IN ('anthropic', 'anthropic-vertex', 'google', 'openai', 'openrouter', 'xai'));

COMMENT ON COLUMN invocations.provider IS 'LLM provider used for this invocation (anthropic, anthropic-vertex, google, openai, openrouter, xai).';
