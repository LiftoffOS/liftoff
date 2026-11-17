-- Migration 394: record which models can actually look at a picture.
--
-- `models.capabilities` has existed since migration 001 and is read by NOTHING.
-- Inbound media gives it its first consumer and its first hard requirement: a
-- model that cannot see must never be handed an image block. Handing one to a
-- text-only model is not a degraded answer, it is a 400 from the vendor, and
-- the failure lands on a person who has just attached a screenshot.
--
-- The column is jsonb and it is NOT empty — migration 303 seeds Claude Opus 5
-- with four capabilities, 187 seeds three more rows, and 284/322/380 seed
-- '["tools","streaming"]'. So this APPENDS to arrays that already have contents
-- rather than filling empty ones, and it must survive the one seed (059) whose
-- array uses a different vocabulary entirely. jsonb || jsonb does that; a
-- rewrite would silently drop whatever each row already said.
--
-- Two rows are also REGISTERED here rather than only updated. `claude-sonnet-5`
-- and `claude-haiku-4-5` are what TIER_MODELS in src/llm/providers/anthropic.ts
-- actually resolves 'medium' and 'small' to, and neither has ever had a row —
-- the registry carries `claude-sonnet-4-6` and the dated
-- `claude-haiku-4-5-20251001` instead. A capability lookup that cannot find its
-- model answers "no", so without these two the vision gate would quietly
-- refuse images on the two tiers most chat traffic runs on.
--
-- Only models this estate has verified are marked. An unmarked model is not
-- broken: it gets the honest text note saying the picture cannot be seen, which
-- is the correct answer for a text-only model and a survivable one for a
-- vision model somebody forgets to mark. The opposite default is not
-- survivable, so absence means no.

BEGIN;

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('Claude Sonnet 5', 'anthropic', 'claude-sonnet-5', 'medium', 'approved',
   '["text-generation", "function-calling", "reasoning", "vision"]'::jsonb),
  ('Claude Haiku 4.5', 'anthropic', 'claude-haiku-4-5', 'small', 'approved',
   '["text-generation", "function-calling", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

-- Append 'vision' where it is missing. Idempotent on re-run, and a no-op for a
-- row that already carries it.
UPDATE models
   SET capabilities = capabilities || '["vision"]'::jsonb,
       updated_at   = NOW()
 WHERE model_id IN (
         'claude-opus-5',
         'claude-opus-4-7',
         'claude-sonnet-5',
         'claude-sonnet-4-6',
         'claude-haiku-4-5',
         'claude-haiku-4-5-20251001',
         'gpt-5.4'
       )
   AND NOT (capabilities @> '["vision"]'::jsonb);

COMMIT;
