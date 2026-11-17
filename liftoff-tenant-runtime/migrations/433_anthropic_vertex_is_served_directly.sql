-- 433: no stored agent configuration names 'anthropic-vertex' any more.
--
-- Claude served over Google Vertex is being retired platform-wide. The provider
-- was only a failover rung, but a stored configuration can still PIN it, and
-- stored configuration outlives the code that understood it.
--
-- This is the half that must land FIRST, in its own deploy, while the provider
-- still exists. Deleting it while a stored value still names it is not a
-- degraded experience, it is three hard failures: resolveModelForTier THROWS on
-- a provider with no catalogue (every chat turn on that AI team dies),
-- createAdapter THROWS through its `never` exhaustiveness guard (autonomous
-- runs die at dispatch), and llmClient.complete throws "Provider
-- 'anthropic-vertex' is not available".
--
-- Vertex and the direct API serve THE SAME Anthropic models under the same
-- ids, so 'anthropic' is not a substitution or a downgrade — it is the same
-- model over the direct transport. No model id is rewritten; only the transport
-- name.
--
-- Two mechanisms, and both are needed for different reasons — the same pairing
-- migration 399 used for the gateway name. provider-resolution.ts translates at
-- READ time, which covers a row arriving AFTER this runs (a resumed context, a
-- replayed event, a control plane not yet on its own migration 521). This gives
-- the stored data a defined end, so the read-time translation stays a
-- compatibility path rather than becoming the permanent way the field is
-- understood.
--
-- HISTORY IS NOT REWRITTEN. `invocations.provider` keeps every
-- 'anthropic-vertex' row exactly as written and the CHECK constraint keeps
-- admitting the value (migration 400 is its current definition) — an
-- invocations row records what ran, and dropping the value would make those
-- rows unupdatable and break repricing. The pricing, accounting and branding
-- paths keep resolving it forever. This migration touches CONFIGURATION, which
-- is what a future call will do, and never a record of what a past call did.
--
-- `cached_model_configs.routing_policy` is the tenant's workspace policy,
-- cached from the control plane and refreshed from it, so it is NOT rewritten
-- here — platform-backend migration 521 moves the source and the cache follows.
-- Rewriting a cache in place is how a cache and its source start disagreeing.
--
-- `agents` is not a row-level-security table in this database, so there is no
-- NO FORCE / FORCE wrapper: adding one would be a false claim about the table
-- and the RLS ratchet reads this file's text.
--
-- Idempotent: scoped to rows that still say 'anthropic-vertex'.

UPDATE agents
   SET model_config = jsonb_set(model_config, '{provider}', '"anthropic"'::jsonb),
       updated_at   = NOW()
 WHERE model_config->>'provider' = 'anthropic-vertex';
