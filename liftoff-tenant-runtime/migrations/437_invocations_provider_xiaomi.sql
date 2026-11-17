-- 437: admit 'xiaomi' as an invocations.provider value.
--
-- Xiaomi became its own execution provider in VENDORS, so a run on it resolves
-- that name and the invocation-row insert fails before the adapter starts:
--   new row for relation "invocations" violates check constraint "chk_invocations_provider"
--
-- The rule, restated because migration 400 already restated it after four
-- misses (310 for 'openrouter', 391 for 'xai', 398 for qwen/deepseek/kimi, 399
-- for the family split, 400 for minimax) and this is the sixth: the constraint
-- is a hand-written copy of a TypeScript union, in SQL where the type system
-- cannot see it, so it has to be widened in the SAME change that adds a
-- provider. It was missed here too, and
-- `scripts/__tests__/invocations-provider-constraint.test.ts` is what caught it
-- — in CI rather than in a live run, where the symptom is a constraint name
-- instead of a vendor name.
--
-- 'openrouter' is carried forward unchanged: nothing resolves to it since the
-- family split, and rows written before it still do.
--
-- The engine constraints need nothing — xiaomi resolves to OPEN_WEIGHTS_ENGINE,
-- which is already admitted.

ALTER TABLE invocations DROP CONSTRAINT IF EXISTS chk_invocations_provider;
ALTER TABLE invocations ADD CONSTRAINT chk_invocations_provider
  CHECK (provider IN (
    'anthropic', 'anthropic-vertex', 'google', 'openai', 'xai',
    'glm', 'qwen', 'deepseek', 'kimi', 'minimax', 'xiaomi',
    -- Historical only. Nothing resolves to it; rows written before the split
    -- carry it.
    'openrouter'
  ));

COMMENT ON COLUMN invocations.provider IS 'Model FAMILY this invocation ran on (anthropic, anthropic-vertex, google, openai, xai, glm, qwen, deepseek, kimi, minimax, xiaomi; openrouter is historical).';
