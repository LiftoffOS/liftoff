-- 521: no stored configuration names 'anthropic-vertex' any more.
--
-- Claude served over Google Vertex is being retired. The provider was only
-- the third rung of the failover ladder, but a workspace or an AI team could
-- still have it PINNED in stored configuration, and stored configuration
-- outlives the code that understood it.
--
-- This migration is the half that must land FIRST, in its own deploy, while
-- `AnthropicVertexProvider` still exists and still works. Deleting the provider
-- while a stored value still names it is not a degraded experience, it is three
-- hard failures: the runtime's resolveModelForTier throws on a provider with no
-- catalogue (every chat turn on that team dies), createAdapter throws through
-- its `never` exhaustiveness guard (autonomous runs die at dispatch), and
-- llmClient.complete throws "Provider 'anthropic-vertex' is not available".
--
-- Vertex and the direct API serve THE SAME Anthropic models under the same
-- ids, so 'anthropic' is not a substitution or a downgrade — it is the same
-- model over the direct transport. No model id is rewritten here; only the
-- transport name.
--
-- HISTORY IS NOT REWRITTEN. `llm_usage_log.provider` and `invocations.provider`
-- keep every 'anthropic-vertex' row exactly as written, and the pricing,
-- ingestion, branding and repricing paths keep resolving the value forever.
-- This migration touches CONFIGURATION — what a future call will do — and
-- never a record of what a past call did.
--
-- internal_agent_versions is included, and that is the whole reason this is not
-- a copy of migration 450. A rollback restores a version's saved model_config
-- verbatim, so a table left alone here would quietly REINTRODUCE the removed
-- provider the first time anyone rolled an AI team back. Migration 197 updated
-- both tables together for exactly this reason; 450 did not, and only got away
-- with it because the gateway names it rewrote were never pinned per version.
--
-- RLS. `internal_agents` and `model_configs` are FORCE row-level-security and
-- this rewrites rows across every tenant, so no single tenant scope could be
-- bound. Migrations run as liftoff_app, which owns both tables, so dropping
-- FORCE for the length of this transaction is the owner's equivalent of the
-- admin pool's BYPASSRLS; ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT, so
-- no other session observes either table unforced. Same shape as 383, 384, 417
-- and 450. `internal_agent_versions` is not an RLS table and needs no wrapper.
--
-- Idempotent: every statement is scoped to rows that still say
-- 'anthropic-vertex', so a re-run is a no-op.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   NO FORCE ROW LEVEL SECURITY;

-- ── Per-AI-team pinned provider ─────────────────────────────────────────────
UPDATE internal_agents
   SET model_config = jsonb_set(model_config, '{provider}', '"anthropic"'::jsonb),
       updated_at   = NOW()
 WHERE model_config->>'provider' = 'anthropic-vertex';

-- ── The saved versions a rollback restores ──────────────────────────────────
UPDATE internal_agent_versions
   SET model_config = jsonb_set(model_config, '{provider}', '"anthropic"'::jsonb)
 WHERE model_config->>'provider' = 'anthropic-vertex';

-- ── Workspace routing policy: the default ───────────────────────────────────
-- The policy names a provider twice: once as the default, and once per
-- background task in providerOverrides. The runtime resolves
-- `providerOverrides[task] || defaultProvider`, so rewriting only the default
-- would leave each task on the retired name while the workspace moved off it.
UPDATE model_configs
   SET routing_policy = jsonb_set(routing_policy, '{defaultProvider}', '"anthropic"'::jsonb),
       updated_at     = NOW()
 WHERE routing_policy->>'defaultProvider' = 'anthropic-vertex';

-- ── Workspace routing policy: every per-task override ───────────────────────
-- Unconditional unlike migration 450's version: there is one destination, so no
-- per-task model has to be consulted to decide where a value goes.
--
-- `jsonb_typeof(...) = 'object'` guards jsonb_each, which raises on a scalar or
-- an array. A policy written by hand can hold anything.
UPDATE model_configs mc
   SET routing_policy = jsonb_set(
         mc.routing_policy,
         '{providerOverrides}',
         (SELECT jsonb_object_agg(k,
                   CASE WHEN v #>> '{}' = 'anthropic-vertex' THEN '"anthropic"'::jsonb ELSE v END)
            FROM jsonb_each(mc.routing_policy->'providerOverrides') AS t(k, v))),
       updated_at = NOW()
 WHERE jsonb_typeof(mc.routing_policy->'providerOverrides') = 'object'
   AND mc.routing_policy->'providerOverrides' @> '{}'::jsonb
   AND EXISTS (
     SELECT 1 FROM jsonb_each(mc.routing_policy->'providerOverrides') AS t(k, v)
      WHERE v #>> '{}' = 'anthropic-vertex'
   );

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   FORCE ROW LEVEL SECURITY;

COMMIT;
