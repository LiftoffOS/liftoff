-- Migration 523: the three xAI rows whose window nothing was ever going to fill.
--
-- Found by the gate migration 522 was written alongside — the context-window
-- assertion in scripts/ci/check-registry-drift.sh — on its first run against a
-- freshly migrated database. It is the exact defect that gate exists for, and
-- it is worth recording how it happened, because the same accident is cheap to
-- repeat.
--
-- Migration 380 registered the Grok models with `context_window` deliberately
-- NULL, and said so in its own header: "the model-pricing-sync job records it
-- from the live endpoints API, and that job also reports any approved model
-- still missing one, so a NULL is visible rather than silent." That was true
-- when it was written. It is not true now.
--
-- `sync-model-pricing.ts` sizes exactly the providers in
-- `OPENROUTER_HOSTED_PROVIDERS`, which is derived from the vendors whose
-- `transport` is 'openrouter' (workspace-ai-vendors.ts). xAI's transport is
-- 'direct'. So the job never selects these rows, never reads an endpoint for
-- them, and never reports them either — the coverage line it logs runs over
-- `models` and would have named them, but nothing reads a log line as a gate.
-- Three approved, reachable models have therefore been running against the
-- conservative 128,000-token fallback: every turn on them closed at roughly
-- 90,000 tokens, which for grok-4.3 is nine per cent of the window the
-- workspace is paying for.
--
-- Nothing failed while that was true, which is the whole point. An unrecorded
-- window degrades silently — the runtime falls back to a family floor, keeps
-- logging ratios, and simply stops being allowed to retire a session.
--
-- EVERY FIGURE HAS TWO AGREEING SOURCES, which is migration 343's standard and
-- the reason it exists: recording a window licenses a consumer to end a session
-- on it, so a number we are unsure of is worse than none. Both sources are
-- xAI's own, read on 2026-09-22 and cited per row below.
--
-- Scoped `WHERE context_window IS NULL`, as 343, 397, 520 and 522 are, so
-- re-running this — or applying it after an operator has corrected a value
-- through PUT /api/model-registry/:id/context-window — never overwrites a
-- deliberate entry with a historical one.
--
-- `models` is a GLOBAL non-RLS catalog (see repository.ts): plain UPDATEs, no
-- tenant scope, no FK/RLS traps.
--
-- The model ids are the ones the Workspace AI vendor map resolves — the bare
-- xAI ids under provider 'xai', not the `x-ai/...` gateway slugs migration 380
-- first wrote. Migration 450 moved the rows to the execution provider key, and
-- these are what a request actually reaches.

BEGIN;

-- 500,000 per the Context column of the Text API pricing table at
-- docs.x.ai/docs/models, and independently per the "At a glance" figure and the
-- `maxPromptLength` in the languageModels payload on
-- docs.x.ai/developers/grok-4-5.
UPDATE models SET context_window = 500000, updated_at = NOW()
 WHERE provider = 'xai' AND model_id = 'grok-4.6' AND context_window IS NULL;

-- 1,000,000 per the Context column at docs.x.ai/docs/models, and independently
-- per docs.x.ai/developers/migration/may-15-retirement ("a 1 million token
-- context window").
UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'xai' AND model_id = 'grok-4.3' AND context_window IS NULL;

-- 1,000,000 per the Context column at docs.x.ai/docs/models, and independently
-- per `maxPromptLength` in xAI's own model listing for this id.
UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'xai' AND model_id = 'grok-4.20-0309-non-reasoning' AND context_window IS NULL;

COMMIT;
