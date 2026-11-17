-- 342: models.context_window — how many tokens a model can actually hold.
--
-- Nothing in either plane knows this today. The tenant runtime's only window
-- knowledge is a four-entry PROVIDER_WINDOW_TOKENS map that describes itself as
-- "floors, not exact model specs", and the control-plane `Model` type carries
-- id, name, provider, model_id, tier, status and capabilities — no window.
--
-- The floor cannot stand in for the real number, and the gap is not academic:
-- Anthropic's floor is 200,000 while claude-opus-5[1m] holds 1,000,000. Any
-- consumer that treats "used more than the window" as evidence of overflow would
-- read a healthy 300k-token run on that model as saturated. Wired to a
-- retirement decision, that abandons a perfectly good session — a data-losing
-- false positive produced by the very check meant to prevent data loss.
--
-- So the number is recorded per model, here, where models are already onboarded,
-- and served to the runtime alongside the pricing and branding overlays it
-- already installs from this registry. One row per model, one source of truth,
-- no per-repo edit when a model is added.
--
-- Nullable with no backfill and no default. A NULL means "we have not recorded
-- this model's window", which is different from any number we could invent, and
-- consumers must be able to tell the two apart: a known window may drive a
-- retirement, an unknown one may not. Filling it with a guess would erase
-- exactly that distinction.

ALTER TABLE models
  ADD COLUMN IF NOT EXISTS context_window integer;

ALTER TABLE models
  ADD CONSTRAINT models_context_window_positive
  CHECK (context_window IS NULL OR context_window > 0);

COMMENT ON COLUMN models.context_window IS
  'Maximum context tokens this model accepts, or NULL when it has not been recorded. Served to the tenant runtime by GET /api/internal/model-registry and installed there as a third overlay beside pricing and branding. NULL is meaningful and must not be defaulted: a consumer may only make a destructive decision (retiring a session as context-exhausted) on a recorded window, never on a provider-family floor, because the floor understates every long-window model — Anthropic''s floor is 200000 while claude-opus-5[1m] holds 1000000.';
