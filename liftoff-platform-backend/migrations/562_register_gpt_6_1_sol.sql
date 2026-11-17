-- Migration 562: Register GPT-6.1 Sol as the medium-tier OpenAI model
--
-- `gpt-6.1-sol` succeeds `gpt-6-sol` in the MEDIUM slot. The tier is the point
-- worth stating: OpenAI positions 6.1 Sol as "near-Astra performance at a lower
-- cost", which reads like a promotion, and the ladder here is fixed by the
-- vendor's own price list rather than by that sentence — $10 / $2 / $0.10 per
-- million input for astra / sol / luna. 6.1 Sol is $2, so it is the medium slot
-- its predecessor held. `gpt-6-astra` keeps `flagship` and keeps the large tier
-- through the vendor map. Reading the ladder off the name or the marketing is
-- how a $2 model comes to be charged as a $10 one (providers/openai.ts).
--
-- `gpt-6-sol` KEEPS its row, its tier and its approved status. It stops
-- resolving because `findByTierAndProvider` takes the newest approved row for a
-- tier — but every invocation already written against it must still find a row,
-- a rate and a window. Nothing is removed; the reasoning 520 and 559 applied.
--
-- WHAT CHANGED IN ITS PRICE, AND THE ONE FIGURE THAT IS NOT A TYPO. Base input,
-- cache writes and output are identical to gpt-6-sol ($2 / $2.50 / $10, and the
-- long band $4 / $5 / $15). The CACHED INPUT rate halves: $0.10 where gpt-6-sol
-- is $0.20, and $0.20 in the long band where gpt-6-sol is $0.40. That is 5% of
-- base input where every sibling in this family is 10% — astra $1.00 on $10 and
-- luna $0.01 on $0.10 — and it is the vendor's own published figure, confirmed
-- against developers.openai.com/api/docs/pricing on 2026-09-29. A reader who
-- "corrects" it to 10% doubles what every cache read costs, on the tier that
-- does the most caching. The rate itself lives in `MODEL_PRICING`, where this
-- family's first-party rates live; this migration records the routing facts.
--
-- CAPABILITIES: text-generation, function-calling, reasoning, vision — the same
-- set 527 gave gpt-6-sol, and the model page confirms both function calling and
-- image input for 6.1.
--
-- WINDOW: 1,050,000. The model page publishes 1,050,000 context / 922,000 max
-- input / 128,000 max output, and 1,050,000 is what this table holds for every
-- OpenAI row — the whole GPT-6 line and the 5.6 line before it (527, 397). The
-- total is the convention here, so a turn bound derived from it compares like
-- with like across the estate; recording 922,000 for this one model alone would
-- make it the exception nobody expects. Max output is still NOT recorded: this
-- table has no column for it and inventing one to hold a fact nothing reads is
-- 397's reasoning, unchanged.
--
-- Scoped `WHERE context_window IS NULL`, as 343, 397, 520, 522, 527 and 559 are,
-- so re-running this — or applying it after an operator has corrected the value
-- through PUT /api/model-registry/:id/context-window — never overwrites a
-- deliberate entry with a historical one.
--
-- `models` is a GLOBAL non-RLS catalog: plain upsert, no tenant scope, no
-- FK/RLS traps. Idempotent via ON CONFLICT (model_id).

BEGIN;

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('GPT-6.1 Sol', 'openai', 'gpt-6.1-sol', 'medium', 'approved',
   '["text-generation", "function-calling", "reasoning", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

UPDATE models
   SET context_window = 1050000,
       updated_at     = NOW()
 WHERE provider = 'openai'
   AND model_id = 'gpt-6.1-sol'
   AND context_window IS NULL;

COMMIT;
