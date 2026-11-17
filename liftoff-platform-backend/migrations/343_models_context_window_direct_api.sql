-- Record the context window for the approved models we call on a vendor's own
-- API, so the per-model window path is not inert for them.
--
-- Migration 342 added the column, correctly nullable and correctly with no
-- backfill: NULL means "we have not recorded this", which is a different fact
-- from any number we could invent, and the runtime is built to tell them apart.
-- What it left behind was a catalog in which EVERY approved model was NULL and
-- nothing could set one, so every reading resolved to a provider-family floor —
-- and a floor may never drive a destructive decision. Structural overflow
-- detection and the saturation signal were therefore dead on arrival for the
-- whole catalog.
--
-- The OpenRouter-hosted models do not need this: the model-pricing-sync job
-- reads their window from the endpoints API on every run, so they self-heal.
-- The direct-API providers have no such source in this estate. Their windows
-- are recorded here, and corrected afterwards through
-- PUT /api/model-registry/:id/context-window.
--
-- Each number below was taken from the vendor's own published model
-- documentation on 2026-08-09 and independently agreed by OpenRouter's
-- endpoints API for the same model. Where the two had disagreed, none would
-- have been recorded: a window we are unsure of is worse than no window,
-- because recording it licenses the runtime to end a session on it.
--
-- Scoped `WHERE context_window IS NULL` so that re-running this, or applying it
-- after an operator has already corrected a value, never overwrites a
-- deliberate entry with a historical one.

UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-opus-5' AND context_window IS NULL;

UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-opus-4-7' AND context_window IS NULL;

UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-sonnet-4-6' AND context_window IS NULL;

UPDATE models SET context_window = 200000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-haiku-4-5-20251001' AND context_window IS NULL;

UPDATE models SET context_window = 1050000, updated_at = NOW()
 WHERE provider = 'openai' AND model_id = 'gpt-5.4' AND context_window IS NULL;
