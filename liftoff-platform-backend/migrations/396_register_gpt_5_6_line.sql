-- Migration 396: the OpenAI tier ladder moves to the GPT-5.6 line.
--
-- Migration 395 registered `gpt-5.5` as the OpenAI flagship because that is what
-- the Workspace AI vendor map named. The current line is GPT-5.6, whose tiers
-- are named rather than numbered:
--
--   flagship  gpt-5.6-sol
--   medium    gpt-5.6-terra
--   small     gpt-5.6-luna
--
-- Fixed forward rather than by editing 395. `pgmigrations` records filenames, so
-- an edit to a recorded file runs in no database that already has it while a
-- from-scratch rebuild gets the new text, and the two disagree forever with
-- nothing comparing them. 395 has not reached an environment — the build
-- carrying it failed before the migrate step — but "probably nowhere" is not a
-- basis for editing a migration, and a developer's local database is an
-- environment too. Migration 140 is the recorded cost of the other choice.
--
-- `gpt-5.5` is DISABLED rather than deleted. Nothing resolves to it any more, so
-- leaving it approved would have the registry advertise a tier answer no code
-- asks for, and would put it in front of the pricing-coverage report forever.
-- Deleting it instead would mean a DELETE against a table `model_configs`
-- references by id; disabling costs nothing, cannot orphan a foreign key, and
-- leaves the row readable as what it is — a model this estate registered and
-- then did not adopt. 'disabled' is the same status the per-vendor kill switch
-- in migrations 322 and 380 uses.
--
-- `gpt-5.4` is untouched: still approved, still priced, still marked vision, and
-- still DEFAULT_MODEL in providers/openai.ts — what a request carrying neither a
-- model nor a tier resolves to. It is deliberately not on the ladder.
--
-- No modality capability on the three new rows. Whether the GPT-5.6 line accepts
-- images was not investigated, and unmarked is the safe direction: an unmarked
-- model is told in words that the picture cannot be read, while a wrongly marked
-- one returns a 400 from the vendor to somebody who just attached a screenshot.
--
-- context_window is left NULL, per migration 343's rule: a window is recorded
-- only from a source we can stand behind, because the runtime is permitted to
-- end a session on a recorded one. OpenAI publishes no endpoint API this estate
-- can read, so these are recorded by hand through
-- PUT /api/model-registry/:id/context-window, and the model-pricing-sync job
-- names every approved model still missing one on every run.

BEGIN;

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('GPT-5.6 Sol',   'openai', 'gpt-5.6-sol',   'flagship', 'approved',
   '["text-generation", "function-calling", "reasoning"]'::jsonb),
  ('GPT-5.6 Terra', 'openai', 'gpt-5.6-terra', 'medium',   'approved',
   '["text-generation", "function-calling", "reasoning"]'::jsonb),
  ('GPT-5.6 Luna',  'openai', 'gpt-5.6-luna',  'small',    'approved',
   '["text-generation", "function-calling"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

-- Idempotent, and a no-op once already disabled.
UPDATE models
   SET status     = 'disabled',
       updated_at = NOW()
 WHERE model_id = 'gpt-5.5'
   AND status <> 'disabled';

COMMIT;
