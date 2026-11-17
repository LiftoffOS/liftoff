-- Grok's rates come from xAI's price list, and were a whole band too high.
--
-- `model_pricing` still held Grok under OpenRouter's key — (provider
-- 'openrouter', model_id 'x-ai/grok-4.6') — sourced from openrouter-models-api.
-- Since migration 417 the cost path builds `xai:grok-4.6`, so those rows match
-- nothing and the code literals have been the only rates in effect.
--
-- Which mattered, because the literals were wrong. They were OpenRouter's
-- MAX-across-serving-endpoints figures, and that maximum happens to equal xAI's
-- ABOVE-200k band. So the base rate charged was xAI's long-context rate, and the
-- override on top of it doubled again to a rate xAI does not publish at all:
--
--                     charged (base / >200k)     xAI publishes (base / >=200k)
--   grok-4.6            4.00 / 8.00  in           2.00 / 4.00  in
--                      12.00 / 24.00 out          6.00 / 12.00 out
--   grok-4.3            2.50 / 5.00  in           1.25 / 2.50  in
--                       5.00 / 10.00 out          2.50 / 5.00  out
--   grok-4.20           same as 4.3               same as 4.3
--
-- Every Grok call was costed at 2x, and one over 200k at 4x. Nothing failed:
-- `computeRowCost` never returns 0, so a wrong rate is charged confidently on
-- every row, which is the same way the Qwen bands were wrong in the other
-- direction (INVARIANT 13).
--
-- THE THRESHOLD IS 199_999 ON PURPOSE. `minPromptTokens` is STRICTLY GREATER —
-- that is OpenRouter's rule, verified against their docs, and it is what this
-- wire shape means for every model that uses it. xAI's rule is different:
-- "requests whose prompt REACHES 200k tokens are billed at the higher rate for
-- all tokens in the request", which is inclusive. 199_999 is how an inclusive
-- 200k is spelled in an exclusive field. Do not "correct" it to 200_000: that
-- bills a prompt of exactly 200,000 tokens at half rate.
--
-- Source: docs.x.ai/docs/models, read 2026-09-04. Grok is no longer in
-- OPENROUTER_PROVIDERS, so the pricing sync does not refresh these and they
-- stay as written until xAI changes its list.
--
-- `model_pricing` is not RLS, so no fence is needed here.

BEGIN;

-- The OpenRouter-keyed rows are unreachable after 417 and carry rates that are
-- wrong for the account these models now bill to. Removed rather than left as a
-- second, staler answer to the same question.
DELETE FROM model_pricing
 WHERE provider = 'openrouter'
   AND model_id LIKE 'x-ai/grok-%';

INSERT INTO model_pricing
  (provider, model_id, input_per_m, output_per_m, cache_read_per_m, source, source_slug, pricing_overrides)
VALUES
  ('xai', 'grok-4.6',  2.00, 6.00, 0.50, 'xai-published-list', 'grok-4.6',
   '[{"minPromptTokens": 199999, "input": 4.00, "output": 12.00, "cacheRead": 1.00}]'::jsonb),
  ('xai', 'grok-4.3',  1.25, 2.50, 0.20, 'xai-published-list', 'grok-4.3',
   '[{"minPromptTokens": 199999, "input": 2.50, "output": 5.00,  "cacheRead": 0.40}]'::jsonb),
  ('xai', 'grok-4.20', 1.25, 2.50, 0.20, 'xai-published-list', 'grok-4.20',
   '[{"minPromptTokens": 199999, "input": 2.50, "output": 5.00,  "cacheRead": 0.40}]'::jsonb)
ON CONFLICT (provider, model_id) DO UPDATE
   SET input_per_m       = EXCLUDED.input_per_m,
       output_per_m      = EXCLUDED.output_per_m,
       cache_read_per_m  = EXCLUDED.cache_read_per_m,
       source            = EXCLUDED.source,
       source_slug       = EXCLUDED.source_slug,
       pricing_overrides = EXCLUDED.pricing_overrides,
       synced_at         = NOW();

COMMIT;
