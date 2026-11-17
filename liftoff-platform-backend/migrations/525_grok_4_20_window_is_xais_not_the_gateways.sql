-- Migration 525: grok-4.20-0309-non-reasoning is a 1,000,000-token model, and
-- the registry has been calling it a 2,000,000-token one.
--
-- Migration 523 recorded the right figure and could not apply it. It is scoped
-- `WHERE context_window IS NULL`, which is the correct scope for filling a gap
-- and the wrong one for repairing a value, so it landed as a no-op on every
-- environment that already held the wrong number: a database rebuilt from this
-- chain gets 1,000,000, while an existing database keeps 2,000,000. Two answers to the
-- same question, and nothing compares them.
--
-- WHERE THE 2,000,000 CAME FROM, because it was not careless and the same
-- accident is cheap to repeat. No migration ever wrote it. The pricing sync
-- did, from OpenRouter's catalog, back when Grok was reached THROUGH that
-- gateway — `sync-model-pricing.ts` sizes the rows whose provider is in
-- `OPENROUTER_HOSTED_PROVIDERS`, and Grok qualified until the vendor was given
-- `transport: 'direct'`. So the figure is the
-- GATEWAY's advertised context length for its own `x-ai/grok-4.20` slug, not
-- xAI's for the model we actually call. The moment the transport went direct
-- the sync stopped selecting these rows, and the stale gateway figure froze
-- with nothing left that could correct it.
--
-- WHY IT MATTERS more than a wrong number usually does. The recorded window is
-- what the turn bound is taken from, so this one row inverts the guard:
--
--   guarded close   0.7  x 2,000,000 = 1,400,000 tokens
--   real window                        1,000,000 tokens
--
-- The close therefore sits ABOVE the window it is meant to protect and can
-- never fire; xAI rejects the request first. Destructive retirement at 0.99 is
-- further out still. For this one model the guard is not conservative or
-- approximate, it is unreachable — which is the exact failure the bound exists
-- to prevent, arrived at from the opposite direction: not a window too small to
-- use, but one too large to be true.
--
-- THE FIGURE IS xAI'S OWN, with the two agreeing sources migration 343's
-- standard asks for, read on 2026-09-22 and unchanged here from 523: the
-- Context column at docs.x.ai/docs/models, and independently `maxPromptLength`
-- in xAI's own model listing for this id.
--
-- Scoped to the WRONG VALUE rather than applied unconditionally. That keeps it
-- idempotent, says in the statement itself exactly what it repairs, and leaves
-- a deliberate operator entry made through
-- PUT /api/model-registry/:id/context-window alone — the one writer besides the
-- sync that can set this column. On a from-scratch rebuild 523 has already set
-- 1,000,000 and this is correctly a no-op.
--
-- `models` is a GLOBAL non-RLS catalog (see repository.ts): a plain UPDATE, no
-- tenant scope, no FK/RLS traps.

BEGIN;

UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'xai'
   AND model_id = 'grok-4.20-0309-non-reasoning'
   AND context_window = 2000000;

COMMIT;
