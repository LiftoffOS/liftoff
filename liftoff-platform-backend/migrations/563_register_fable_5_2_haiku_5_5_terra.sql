-- Migration 563: Register Claude Fable 5.2, Claude Haiku 5.5 and GPT-6.1 Terra
--
-- Three models the vendors have published and this registry did not carry. Two
-- of them take a slot; the third deliberately takes none.
--
-- CLAUDE FABLE 5.2 — the Frontier designation, replacing Fable 5.1
-- (WORKSPACE_AI_VENDORS.anthropic.frontier). NULL tier, on 529's terms: no tier
-- routes to Fable, so a tier value here could only displace Opus 5.5 from large.
-- CHEAPER than the model it succeeds ($8 / $40 against $10 / $50), which is the
-- direction this whole generation moved in, so a rate carried forward on the
-- family name over-charges rather than under-charges. Released 2026-11-09;
-- 1,000,000 context / 128,000 max output per
-- platform.claude.com/docs/en/models/fable-5-2/overview, read 2026-11-12.
--
-- CLAUDE HAIKU 5.5 — the SMALL tier, replacing Haiku 4.5. Two things make this
-- more than a version bump:
--
--   1. IT IS A TENTH OF THE PRICE ($0.10 against $1.00 input) and the small
--      tier is the busiest path, so this is a large cost change. The saving is not the full 10x: this model uses
--      the Claude 4.7+ tokenizer, so the same text counts about 30% more tokens
--      than on Haiku 4.5 — roughly 7.7x on identical prompts.
--
--   2. IT IS THE FIRST ANTHROPIC MODEL WITH A PROMPT-LENGTH BAND. A request
--      whose prompt exceeds 100,000 tokens pays 5x on every rate for the whole
--      request. That lives in MODEL_PRICING's `overrides`, not here — this table
--      has no column for a conditional rate and inventing one to hold a fact
--      nothing reads is 397's reasoning, unchanged.
--
-- The window goes 200,000 -> 1,000,000, which also RAISES the turn bound derived
-- from it; 128,000 max output. Released 2026-10-07, per
-- platform.claude.com/docs/en/models/haiku-5-5/overview, read 2026-11-12.
--
-- Haiku 4.5 KEEPS its row, its `small` tier and its approved status, the way
-- gpt-6-sol did at 562 and Sonnet 5 at 559. It stops resolving because
-- `findByTierAndProvider` takes the newest approved row for a tier
-- (ORDER BY created_at DESC), and this INSERT is newer — but every invocation
-- already written against it must still find a row, a rate and a window.
--
-- GPT-6.1 TERRA — NULL TIER, AND THAT IS THE DECISION IN THIS MIGRATION. At
-- $1 / $5 it sits between the medium slot ($2 / $10, gpt-6.1-sol) and the small
-- one ($0.10 / $0.50, gpt-6-luna). A tier here is an ABSOLUTE capability class —
-- large is Opus-class, medium is Sonnet-class, small is Haiku-class — and not a
-- ranking of one vendor's models against each other, so a model that matches
-- neither class gets no tier rather than the nearest one. Giving it `small`
-- would route the cheapest tier onto a model ten times the price of luna;
-- giving it `medium` would demote a $2 slot onto a $1 model whose published job
-- is vision, computer use and prose.
--
-- The NAME is the trap, in the opposite direction to `sol` at 562: in the
-- GPT-5.6 line `gpt-5.6-terra` WAS the medium tier. A reader pattern-matching
-- on "terra" therefore promotes a model nothing routes to into the slot
-- gpt-6.1-sol holds. 1,050,000 context, which is the convention for every
-- OpenAI row here (the model page publishes 1,050,000 total / 922,000 max input
-- / 128,000 max output; the total is what this table holds, so a turn bound
-- derived from it compares like with like across the estate). Read 2026-11-12
-- from developers.openai.com/api/docs/models/gpt-6.1-terra.
--
-- CAPABILITIES. Both Anthropic rows get 559's set. Terra gets 562's OpenAI set
-- (no `extended-thinking`): its page publishes function calling, structured
-- outputs, image input and reasoning effort down to `none`.
--
-- Every context_window write is scoped `WHERE context_window IS NULL`, as 343,
-- 397, 520, 522, 527, 529 and 559 are, so re-running this — or applying it after
-- an operator has corrected a value through
-- PUT /api/model-registry/:id/context-window — never overwrites a deliberate
-- entry with a historical one. An unsized model is not priced wrong, it is
-- BOUNDED wrong: `contextWindowOrFallback` answers with the conservative
-- 128,000-token floor for any model with no figure, and it is also what
-- `check-registry-drift.sh` exits 1 on.
--
-- `models` is a GLOBAL non-RLS catalog: plain upsert, no tenant scope, no
-- FK/RLS traps. Idempotent via ON CONFLICT (model_id).

BEGIN;

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('Claude Fable 5.2', 'anthropic', 'claude-fable-5-2', NULL, 'approved',
   '["text-generation", "function-calling", "reasoning", "extended-thinking", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  status     = EXCLUDED.status,
  updated_at = NOW();

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('Claude Haiku 5.5', 'anthropic', 'claude-haiku-5-5', 'small', 'approved',
   '["text-generation", "function-calling", "reasoning", "extended-thinking", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('GPT-6.1 Terra', 'openai', 'gpt-6.1-terra', NULL, 'approved',
   '["text-generation", "function-calling", "reasoning", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  status     = EXCLUDED.status,
  updated_at = NOW();

UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-fable-5-2' AND context_window IS NULL;

UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-haiku-5-5' AND context_window IS NULL;

UPDATE models SET context_window = 1050000, updated_at = NOW()
 WHERE provider = 'openai' AND model_id = 'gpt-6.1-terra' AND context_window IS NULL;

COMMIT;
