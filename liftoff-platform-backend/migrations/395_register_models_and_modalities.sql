-- Migration 395: register the six models nothing had a row for, and record
-- which of the rest can look at a picture or watch a video.
--
-- Two things the registry could not answer, both because a row was missing or
-- silent rather than because the schema was wrong. No schema change is needed:
-- `capabilities` is jsonb NOT NULL DEFAULT '[]', `model_id` is unique
-- (models_model_id_key, migration 187), and 'vision' / 'video' are capability
-- strings alongside the vocabulary already in the column.
--
-- 1. SEVEN MODELS WITH NO ROW.
--
-- Three Gemini ids and three GPT ids are reachable at runtime — they are what
-- the Workspace AI vendor map stamps, and now what the provider tier maps
-- resolve — and none of them had a registry row. A missing row is not inert:
-- tier resolution cannot be registry-driven for that provider, the pricing sync
-- cannot reach the model, and the vision gate answers "cannot see" by default.
--
-- The seventh is `text-embedding-004`. It is stamped into EVERY tenant's
-- routing policy as the embedding task override (migration 188) and has never
-- had a row, so the registry has been unable to answer for the one model every
-- tenant runs. It carries no tier: tier means the flagship/medium/small chat
-- ladder, an embedding model sits outside it, and a tier here would put it in
-- the running for a chat tier map. Every consumer that resolves a tier filters
-- on `tier IS NOT NULL` and therefore skips it, which is the correct outcome.
--
-- The three Gemini ids are also the correction of a live bug. `gemini-3.1-pro`
-- and `gemini-3.1-flash` were in the Google provider's tier map and do not
-- exist: Vertex answers 404 for both, so every tier-only Google request on
-- flagship or medium failed. The three registered here answer 200. The Cloud
-- console model list says the opposite; the API is the authority.
--
-- 2. MODALITY, PER MODEL, FROM EVIDENCE.
--
-- Migration 394 marked 'vision' on six Anthropic ids plus gpt-5.4, and
-- src/llm/vision.ts treats an unknown model as no-vision — deliberately, since
-- handing an image to a text-only model is a 400 from the vendor rather than a
-- worse answer. The consequence was that eight vision-capable models refused
-- images they would have accepted. The marks below come from
-- architecture.input_modalities in the live OpenRouter catalog, matched on our
-- exact seeded ids, and from Google's model documentation for Gemini.
--
-- 'video' is recorded rather than assumed absent. Six models across two vendors
-- accept video input, so "no model can watch a video" is true of one vendor and
-- false of this estate.
--
-- The three OpenAI rows are registered with NO modality capability. Whether
-- they accept images was not investigated. Unmarked is the safe direction and
-- it changes nothing about today's behaviour — they already got the text note,
-- because they had no row at all — while registering them fixes tier
-- resolution and the drift test without asserting a capability nobody verified.
--
-- GLM and DeepSeek stay blank on purpose. The live catalog reports
-- input_modalities of text alone for all five of their ids. The blank is the
-- right answer for them, not an omission to be filled in later.
--
-- Appends are guarded by NOT (capabilities @> ...) so a re-run is a no-op, and
-- `jsonb || jsonb` preserves whatever each row already says rather than
-- rewriting the array — migration 394's note applies, including that one seed
-- (059) uses a different vocabulary entirely.

BEGIN;

-- Google: the three ids Vertex actually serves. Marked vision AND video —
-- every current Gemini model accepts image and video input.
--
-- OpenAI: registered for tier resolution and the drift test only. No modality.
--
-- context_window is left NULL rather than hardcoded, and migration 343 is the
-- rule being followed, not an omission: a window is recorded only when the
-- vendor's own documentation and a second source agree, because a window we are
-- unsure of is worse than no window — the runtime is allowed to end a session on
-- a recorded one. Vertex's publisher-model endpoint returns no token limit and
-- neither vendor has an endpoints API this estate can read, so these are
-- recorded by hand through PUT /api/model-registry/:id/context-window. The
-- model-pricing-sync job names every approved model still missing one on every
-- run, so the NULL is visible rather than silent.
INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('Gemini 3.1 Pro Preview', 'google', 'gemini-3.1-pro-preview', 'flagship', 'approved',
   '["text-generation", "function-calling", "reasoning", "vision", "video"]'::jsonb),
  ('Gemini 3.5 Flash',       'google', 'gemini-3.5-flash',       'medium',   'approved',
   '["text-generation", "function-calling", "vision", "video"]'::jsonb),
  ('Gemini 3.1 Flash Lite',  'google', 'gemini-3.1-flash-lite',  'small',    'approved',
   '["text-generation", "function-calling", "vision", "video"]'::jsonb),
  ('GPT-5.5',                'openai', 'gpt-5.5',                'flagship', 'approved',
   '["text-generation", "function-calling", "reasoning"]'::jsonb),
  ('GPT-5.4 Mini',           'openai', 'gpt-5.4-mini',           'medium',   'approved',
   '["text-generation", "function-calling"]'::jsonb),
  ('GPT-5.4 Nano',           'openai', 'gpt-5.4-nano',           'small',    'approved',
   '["text-generation", "function-calling"]'::jsonb),
  -- No tier: an embedding model is not part of the chat ladder. No modality:
  -- it takes text.
  ('Text Embedding 004',     'google', 'text-embedding-004',     NULL,       'approved',
   '["embedding"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

-- Append 'vision' where it is missing. Eight ids, every one of them reporting
-- 'image' among its input modalities in the live OpenRouter catalog.
UPDATE models
   SET capabilities = capabilities || '["vision"]'::jsonb,
       updated_at   = NOW()
 WHERE model_id IN (
         'qwen/qwen3.8-max',
         'qwen/qwen3.7-plus',
         'qwen/qwen3.7-flash',
         'moonshotai/kimi-k3',
         'moonshotai/kimi-k2.6',
         'x-ai/grok-4.6',
         'x-ai/grok-4.3',
         'x-ai/grok-4.20'
       )
   AND NOT (capabilities @> '["vision"]'::jsonb);

-- Append 'video' where it is missing. Three OpenRouter ids report 'video' among
-- their input modalities; the three Gemini ids are listed again so the mark is
-- correct even on a row that already existed and the INSERT above only updated.
UPDATE models
   SET capabilities = capabilities || '["video"]'::jsonb,
       updated_at   = NOW()
 WHERE model_id IN (
         'qwen/qwen3.8-max',
         'qwen/qwen3.7-flash',
         'moonshotai/kimi-k3',
         'gemini-3.1-pro-preview',
         'gemini-3.5-flash',
         'gemini-3.1-flash-lite'
       )
   AND NOT (capabilities @> '["video"]'::jsonb);

COMMIT;
