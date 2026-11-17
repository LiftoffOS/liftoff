-- Migration 522: the eight registry rows that still had no context window.
--
-- Migration 342 added the column, correctly nullable and correctly with no
-- backfill. Migration 343 filled the direct-API rows that existed at the time,
-- 397 filled the GPT-5.6 line, and 520 filled Opus 5.5. Eight rows were never
-- reached, seven of them approved and reachable: every one of those is treated
-- by the runtime and by both platform assistants as a 128,000-token model, and
-- a turn on one is closed at 0.7 of that.
--
-- `claude-sonnet-5` is the sharpest. It holds 1,000,000 tokens and has been
-- closing its turns at roughly 90,000 — nine per cent of the window the
-- workspace is paying for — because nobody recorded the number. The others are
-- the same defect at smaller multiples.
--
-- `gpt-5.5` is DISABLED (migration 396: the OpenAI ladder moved to the GPT-5.6
-- line and nothing resolves to it any more). It is filled anyway, for one
-- reason: a historic `llm_usage_log` row naming it must still find a registry
-- row, a rate and a window, and a row that is readable for its rate and silent
-- for its window is a half-answer nobody can act on. Filling it costs one
-- statement and cannot put it back in front of any resolver — status, not the
-- window, is what takes it out of the running.
--
-- `text-embedding-004` is deliberately NOT here. It is an embedding model: it
-- has no turn and therefore no turn context window, and inventing one would put
-- a number in a column whose whole contract is that NULL means "not recorded".
-- The drift gate skips it for the same reason (it carries no tier).
--
-- EVERY FIGURE IS THE VENDOR'S OWN, read from the documentation cited beside
-- it on 2026-09-22. Migration 343 set the standard and it is the standard being
-- followed here: a window is recorded only from a source we can stand behind,
-- because recording one licenses a consumer to end a session on it, and a
-- number we are unsure of is worse than none.
--
-- Scoped `WHERE context_window IS NULL`, exactly as 343, 397 and 520 are, so
-- re-running this — or applying it after an operator has corrected a value
-- through PUT /api/model-registry/:id/context-window — never overwrites a
-- deliberate entry with a historical one.
--
-- `models` is a GLOBAL non-RLS catalog (see repository.ts): plain UPDATEs, no
-- tenant scope, no FK/RLS traps.
--
-- From here the gap cannot reopen silently: scripts/ci/check-registry-drift.sh
-- asserts, against a freshly migrated database, that every model a request can
-- resolve to and a migration is responsible for carries a window. Its first run
-- found three more this file does not cover — the xAI rows migration 523
-- records, left NULL by migration 380 on an assumption about the pricing sync
-- that stopped being true. Eight was what was known; three was what was
-- found.

BEGIN;

-- ── Anthropic ────────────────────────────────────────────────────────────
-- 1,000,000 per platform.claude.com/docs/en/models/sonnet-5/overview
UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-sonnet-5' AND context_window IS NULL;

-- 200,000 per platform.claude.com/docs/en/models/haiku-4-5/overview.
-- The dated id `claude-haiku-4-5-20251001` already carries this figure from
-- migration 343; this is the undated id migration 394 registered because that
-- is what TIER_MODELS resolves to.
UPDATE models SET context_window = 200000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-haiku-4-5' AND context_window IS NULL;

-- ── Google ───────────────────────────────────────────────────────────────
-- 1,048,576 for all three per ai.google.dev/gemini-api/docs/models (the
-- "Input token limit" row of each model's card). Migration 395 registered
-- these three and left the window NULL because Vertex's publisher-model
-- endpoint returns no token limit; the vendor's own model documentation does,
-- and that is the source 343's rule asks for.
UPDATE models SET context_window = 1048576, updated_at = NOW()
 WHERE provider = 'google' AND model_id = 'gemini-3.1-pro-preview' AND context_window IS NULL;

UPDATE models SET context_window = 1048576, updated_at = NOW()
 WHERE provider = 'google' AND model_id = 'gemini-3.5-flash' AND context_window IS NULL;

UPDATE models SET context_window = 1048576, updated_at = NOW()
 WHERE provider = 'google' AND model_id = 'gemini-3.1-flash-lite' AND context_window IS NULL;

-- ── OpenAI ───────────────────────────────────────────────────────────────
-- 400,000 for both per platform.openai.com/docs/models (the context-window
-- figure on each model's page).
UPDATE models SET context_window = 400000, updated_at = NOW()
 WHERE provider = 'openai' AND model_id = 'gpt-5.4-mini' AND context_window IS NULL;

UPDATE models SET context_window = 400000, updated_at = NOW()
 WHERE provider = 'openai' AND model_id = 'gpt-5.4-nano' AND context_window IS NULL;

-- 1,050,000 per platform.openai.com/docs/models — the same figure migration
-- 397 recorded for the GPT-5.6 line and migration 343 recorded for gpt-5.4,
-- both of which were independently agreed by the endpoint's published
-- context_length. Disabled, and filled for the reason in the header.
UPDATE models SET context_window = 1050000, updated_at = NOW()
 WHERE provider = 'openai' AND model_id = 'gpt-5.5' AND context_window IS NULL;

COMMIT;
