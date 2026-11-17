-- Migration 527: the OpenAI tier ladder moves to the GPT-6 line.
--
-- OpenAI shipped GPT-6 as a three-model line and this estate adopts all three:
--
--   flagship  gpt-6-astra   $10.00 / $50.00 per 1M
--   medium    gpt-6-sol     $ 2.00 / $10.00
--   small     gpt-6-luna    $ 0.10 / $ 0.50
--
-- THE TIER NAMES DID NOT CARRY ACROSS THE GENERATION, and that is the one fact
-- a reader of this file has to hold. `gpt-5.6-sol` was the FLAGSHIP; `gpt-6-sol`
-- is the MEDIUM tier. The ladder above follows the vendor's price list, not the
-- family name — astra is the model priced like a flagship. A row filed by name
-- rather than by price would route every flagship request to a $2 model and
-- brand every medium-tier row as the expensive one.
--
-- SHAPE: migration 520's, not 396's, and the difference is deliberate.
--
--   * 520 registered Opus 5.5 and LEFT Opus 5 approved on its own tier. It is
--     no longer the newest, so `findByTierAndProvider` (DISTINCT ON
--     (provider, tier) ORDER BY created_at DESC) stops resolving to it, while a
--     historic `llm_usage_log` row naming it still finds a registry row, a rate
--     and a context window.
--   * 396 DISABLED gpt-5.5, because no tier resolved to it and leaving
--     it approved would have parked it in front of the pricing-coverage report
--     forever.
--
-- The GPT-5.6 line is the first case, not the second. It has been the routed
-- OpenAI ladder and usage rows name it, so all three keep `approved`
-- and keep their tiers. Disabling them would cost more than it looks: the
-- tenant-runtime's branding and context-window overlays are both served from
-- `status = 'approved'` (model-registry-internal-router.ts), so a disabled row
-- drops out of the codename feed — and a model id with no codename is a vendor
-- token in front of a customer. Nothing is removed here.
--
-- A tenant whose `model_configs.routing_policy` names a concrete GPT-5.6 id
-- keeps running it until that policy is resynced. That is the intended
-- behaviour: the rows stay approved, priced and branded, and no tenant's
-- configuration is rewritten by a migration.
--
-- VISION from the start. Migration 394 exists only because 303 left it out and
-- the inbound-media gate then answered "cannot see" for the flagship. A
-- capability lookup that cannot find its model answers no, so an omission here
-- silently refuses images on the tier most chat traffic runs on. All three
-- models publish `text, image` input modalities on their own model pages
-- (developers.openai.com/api/docs/models/gpt-6-{astra,sol,luna}, read
-- 2026-09-23) and each lists `image_input` under Supported Features — the two
-- agreeing sources migration 397 used for the GPT-5.6 line.
--
-- No `video` and no `audio`: neither source claims either for this line, and the
-- blank is the answer rather than an omission.
--
-- WINDOW: 1,050,000 on all three, from the same model pages, each of which also
-- publishes a 128,000 max-output ceiling. Max output is NOT recorded — this
-- table has no column for it, and inventing one to hold a fact nothing reads is
-- how a column comes to advertise a capability that does not exist (397's
-- reasoning, unchanged).
--
-- Scoped `WHERE context_window IS NULL`, exactly as 343, 397, 520 and 522 are,
-- so re-running this — or applying it after an operator has corrected a value
-- through PUT /api/model-registry/:id/context-window — never overwrites a
-- deliberate entry with a historical one.
--
-- `models` is a GLOBAL non-RLS catalog (see repository.ts): plain upsert, no
-- tenant scope, no FK/RLS traps. Idempotent via ON CONFLICT (model_id).

BEGIN;

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('GPT-6 Astra', 'openai', 'gpt-6-astra', 'flagship', 'approved',
   '["text-generation", "function-calling", "reasoning", "vision"]'::jsonb),
  ('GPT-6 Sol',   'openai', 'gpt-6-sol',   'medium',   'approved',
   '["text-generation", "function-calling", "reasoning", "vision"]'::jsonb),
  ('GPT-6 Luna',  'openai', 'gpt-6-luna',  'small',    'approved',
   '["text-generation", "function-calling", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

UPDATE models
   SET context_window = 1050000,
       updated_at     = NOW()
 WHERE provider = 'openai'
   AND model_id IN ('gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna')
   AND context_window IS NULL;

COMMIT;
