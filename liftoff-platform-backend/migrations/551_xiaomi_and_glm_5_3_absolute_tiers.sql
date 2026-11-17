-- Migration 551: Xiaomi joins the vendor list, GLM moves to the 5.3 line, and
-- five vendors are re-tiered onto ABSOLUTE capability classes.
--
-- THE TIER RULE THIS ENCODES. A tier is an absolute capability class — large is
-- Opus-class, medium is Sonnet-class, small is Haiku-class — and NOT a ranking
-- of a vendor's own models against each other. Read the second way, `large`
-- means a different thing for every vendor, and a Sonnet-class model is sold to
-- a customer as an Opus-class one.
--
-- None of the open-weight vendors publishes anything at the Opus class, so each
-- repeats its Sonnet-class model UPWARD into large. Four of them had it the
-- other way round — the big model sat alone in large and the small model was
-- duplicated across medium and small — which both oversold the large tier and
-- put a Haiku-class model in the Sonnet slot.
--
--   glm       large+medium z-ai/glm-5.3            small z-ai/glm-5.3-flash
--   kimi      large+medium moonshotai/kimi-k3      small moonshotai/kimi-k2.6
--   deepseek  large+medium deepseek/deepseek-v4-pro small deepseek/deepseek-v4.1-flash
--   minimax   large+medium minimax/minimax-m3      small minimax/minimax-m2.7
--   xiaomi    large+medium xiaomi/mimo-v2.6-pro    small xiaomi/mimo-v2.6-flash
--
-- The class calls are the vendors' own published sizes, not price: Kimi K3 is
-- 2.8T, DeepSeek V4 Pro is 1.6T total / 49B activated against V4.1 Flash's 8B
-- on input and 16B on output, MiniMax M3 is ~428B/23B against M2.7's ~229B/10B,
-- MiMo-V2.6-Pro is over 1T against MiMo-V2.6-Flash's 309B/15B.
--
-- HOW A MODEL HOLDS TWO TIERS. It does not: `models.tier` is one column and
-- `model_id` is unique, so a row cannot be both. The loaders resolve a tier to
-- the NEWEST approved row for (provider, tier) and leave a tier the registry
-- does not carry on its code seed — so the large row is registered and MEDIUM
-- IS DELIBERATELY LEFT UNREGISTERED for these five, which makes the seed's
-- medium (the same id as large) the answer. That is the mechanism migrations
-- 322 and 380 already relied on, inverted: it used to be small that went
-- unregistered so the seed could duplicate medium downward.
--
-- Consequence worth stating plainly: every medium row for these vendors has to
-- STOP answering, or the registry would keep resolving medium to the model the
-- code no longer names and the two planes would disagree. That is what the
-- UPDATEs below are for, and `deepseek/deepseek-v4-flash` is the one that is
-- easy to miss — DeepSeek carried TWO rows at medium, and clearing only
-- v4.1-flash would have left v4-flash answering.
--
-- VISION is asserted from two agreeing sources, per the standard migrations 395
-- and 397 set. OpenRouter's catalog reports image input for the MiMo pair and
-- for glm-5.3-flash, and each was PROVEN live through the gateway: sent a solid
-- purple PNG, each answered "Purple". `z-ai/glm-5.3` is deliberately unmarked —
-- the catalog reports it text-only and that was not disproved, and an unmarked
-- model is told in words that it cannot read the picture, while a wrongly
-- marked one returns a 400 to somebody who has just attached a screenshot.
--
-- CONTEXT WINDOWS are recorded, and recorded as the MAXIMUM across the slug's
-- serving endpoints — because that is exactly what the pricing sync's
-- `fetchContextWindow` records, and a migration that wrote a different figure
-- would be overwritten on the next sync run while disagreeing with it in
-- between. The registry-drift assertion EXCUSES these vendors from carrying a
-- window (the sync owns it); it does not forbid one, and the gap until the
-- first sync is not inert: every consumer falls back to a conservative 128,000,
-- so a 1M model closes its turns at about 90,000 — nine per cent of the window
-- the workspace is paying for. That is the defect migration 522 exists for, and
-- leaving four new rows NULL would reintroduce it for as long as the sync takes
-- to run, or indefinitely if it fails.
--
-- Figures read from OpenRouter's endpoints API. The GLM pair
-- spreads widely across its endpoints (262,124 to 1,310,720 over 37 of them);
-- the maximum is taken because that is the sync's documented convention, not
-- because every endpoint offers it.
--
-- `models` is a GLOBAL non-RLS catalog (see repository.ts): plain upsert, no
-- tenant scope, no FK/RLS traps. Idempotent via ON CONFLICT (model_id) and
-- UPDATEs that name the id and the value.
--
-- Nothing is deleted or disabled. Every superseded model keeps its approved row
-- so a historic llm_usage_log row naming it still finds a registry row, a rate
-- and a codename; the outgoing ids simply stop being the newest in their tier
-- (glm-5.2, glm-4.7-flash) or stop holding one at all (glm-5-turbo,
-- deepseek-v4-flash).

BEGIN;

-- ── The new rows ─────────────────────────────────────────────────────────
INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('MiMo V2.6 Pro',   'xiaomi', 'xiaomi/mimo-v2.6-pro',   'large', 'approved',
   '["text-generation", "function-calling", "reasoning", "vision"]'::jsonb),
  ('MiMo V2.6 Flash', 'xiaomi', 'xiaomi/mimo-v2.6-flash', 'small', 'approved',
   '["text-generation", "function-calling", "reasoning", "vision"]'::jsonb),
  -- Text-only: see the VISION note above.
  ('GLM 5.3',         'glm',    'z-ai/glm-5.3',           'large', 'approved',
   '["text-generation", "function-calling", "reasoning"]'::jsonb),
  ('GLM 5.3 Flash',   'glm',    'z-ai/glm-5.3-flash',     'small', 'approved',
   '["text-generation", "function-calling", "reasoning", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

-- ── Medium stops answering, so the code seed supplies it ─────────────────
-- glm-5.2 and glm-4.7-flash are deliberately untouched: both are superseded by
-- a newer row in the same tier, so they already stop resolving while keeping
-- their rate, window and codename for historic rows.
UPDATE models SET tier = NULL, updated_at = NOW()
 WHERE model_id = 'z-ai/glm-5-turbo' AND tier IS DISTINCT FROM NULL;

UPDATE models SET tier = NULL, updated_at = NOW()
 WHERE model_id = 'deepseek/deepseek-v4-flash' AND tier IS DISTINCT FROM NULL;

-- ── The Haiku-class models move from medium to small ─────────────────────
UPDATE models SET tier = 'small', updated_at = NOW()
 WHERE model_id = 'moonshotai/kimi-k2.6' AND tier IS DISTINCT FROM 'small';

UPDATE models SET tier = 'small', updated_at = NOW()
 WHERE model_id = 'deepseek/deepseek-v4.1-flash' AND tier IS DISTINCT FROM 'small';

UPDATE models SET tier = 'small', updated_at = NOW()
 WHERE model_id = 'minimax/minimax-m2.7' AND tier IS DISTINCT FROM 'small';

-- ── Context windows ──────────────────────────────────────────────────────
-- Scoped `WHERE context_window IS NULL`, as 343, 397, 520 and 522 are, so
-- re-running this — or applying it after the sync or an operator has set a
-- value — never overwrites a live figure with a historical one.
UPDATE models SET context_window = 1048576, updated_at = NOW()
 WHERE model_id IN ('xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash')
   AND context_window IS NULL;

UPDATE models SET context_window = 1310720, updated_at = NOW()
 WHERE model_id IN ('z-ai/glm-5.3', 'z-ai/glm-5.3-flash')
   AND context_window IS NULL;

COMMIT;
