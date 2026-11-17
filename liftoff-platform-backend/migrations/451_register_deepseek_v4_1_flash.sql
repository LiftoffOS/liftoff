-- Register DeepSeek V4.1 Flash, and say what a conditional rate band may do.
--
-- 1. THE MODEL.
--
-- DeepSeek shipped V4.1 Flash and the DeepSeek medium/small tier still pointed
-- at V4 Flash. Verified against OpenRouter's live catalog (read 2026-09-11):
-- `deepseek/deepseek-v4.1-flash`, canonical `deepseek/deepseek-v4.1-flash-
-- 20260910`, 1,048,576 context, tools + tool_choice on nine of its eleven
-- serving endpoints.
--
-- An ADD, not a rename, and that is the whole difference from migration 446.
-- 446 moved the Qwen flagship because the id it named did not exist, so nothing
-- could still be using it. `deepseek/deepseek-v4-flash` is a real model that
-- OpenRouter still serves on sixteen endpoints, it keeps its rate row, and the
-- usage rows recorded under it have to keep pricing exactly as they did. So no
-- pin is rewritten here: an agent or a routing policy that names v4-flash goes
-- on naming it, and goes on being charged for it correctly.
--
-- The tier moves on its own. registry-tier-loader.ts reads
-- `DISTINCT ON (tier) … ORDER BY created_at DESC`, so the newer row takes
-- medium the moment it lands, while the v4-flash row stays approved — which
-- keeps the sync job refreshing its live rate and leaves it as the model medium
-- falls back to if v4.1 is ever disabled.
--
-- 'vision' is recorded from the vendor, not assumed. OpenRouter reports
-- `input_modalities: [text, image]` for this id; every DeepSeek model before it
-- was text-only, which is why migration 395 deliberately left the family blank.
-- src/llm/vision.ts reads the mark, so without it a customer who attaches a
-- screenshot is told the model cannot look at one.
--
-- context_window is left NULL on purpose, per migration 343: the sync job reads
-- it from the endpoints API on its next run and records the real figure, and a
-- window we hardcoded would be a second source of truth for a number the
-- vendor already answers.
--
-- Idempotent: `models.model_id` is unique (models_model_id_key, migration 187).
--
-- Kill switch, no redeploy — medium falls back to v4-flash:
--   UPDATE models SET status='disabled' WHERE model_id='deepseek/deepseek-v4.1-flash';
--
-- 2. WHAT A BAND MAY DO (comment only).
--
-- Migration 379 added pricing_overrides and described the shape. It did not say
-- which DIRECTION a band may move the rate, because at the time every band we
-- carried raised it. V4.1 Flash is the first that does not: DeepSeek's own
-- endpoint prices it by time of day, below what ten other endpoints charge
-- flat. Two rules are recorded here rather than living only in code.
--
-- `models` and `model_pricing` are not RLS, so no FORCE dance is needed.

BEGIN;

-- created_at is set EXPLICITLY, and it is the tier resolution rather than
-- bookkeeping. Two DeepSeek rows now carry tier='medium' and the loader breaks
-- the tie on `created_at DESC`, but the column defaults to now(), which is the
-- TRANSACTION timestamp — so in a from-scratch rebuild, where node-pg-migrate
-- applies the pending batch together, this row and migration 322's could take
-- the identical value and the winner would be whichever Postgres felt like.
-- It happens to come out right today only because migrations between the two
-- issue their own COMMIT and split the batch. That is an accident of unrelated
-- files, and it decides which model every DeepSeek medium request routes to.
-- MAX + one microsecond says it outright.
INSERT INTO models (name, provider, model_id, tier, capabilities, status, created_at)
SELECT 'DeepSeek V4.1 Flash', 'deepseek', 'deepseek/deepseek-v4.1-flash', 'medium',
       '["tools","streaming","vision"]'::jsonb, 'approved',
       GREATEST(now(), COALESCE(MAX(created_at), now()) + INTERVAL '1 microsecond')
  FROM models
 WHERE provider = 'deepseek'
ON CONFLICT (model_id) DO NOTHING;

COMMENT ON COLUMN model_pricing.pricing_overrides IS
  'Conditional rate overrides from the vendor, in per-million units. Array of {minPromptTokens?, utcStart?, utcEnd?, utcDays?, input?, output?, cacheRead?, cacheWrite5m?, cacheWrite1h?}. An entry applies when ALL its condition fields match (minPromptTokens is STRICTLY greater-than; utcDays names the UTC weekdays the entry is confined to, lowercase, and is AND-ed with the window rather than folded into it); applicable entries fold in array order, last-writer-wins per key, absent keys inheriting the base columns. A band may only RAISE the base, never lower it: the base columns are the MAX across serving endpoints because routing is unknowable, while a band binds only the endpoint that published it, so sync-model-pricing.ts drops any band key at or below base and an absent key inherits the conservative figure. NULL = no band the vendor publishes raises this model above its base. Evaluated by src/llm/pricing-tiers.ts.';

COMMIT;
