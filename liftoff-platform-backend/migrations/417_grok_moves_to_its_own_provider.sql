-- Grok leaves OpenRouter for its own API, so its model ids become native.
--
-- Migration 380 registered Grok under registry provider 'grok' with OpenRouter's
-- namespaced slugs (`x-ai/grok-4.6`), because that is where it executed. It now
-- executes on api.x.ai, which calls the same model `grok-4.6`; sending the slug
-- there is a 404.
--
-- WHY IT MOVED. Behind OpenRouter, three things could not be expressed:
--   1. WHICH of the five OpenRouter-hosted vendors an agent had chosen — the
--      model came from the shared tier map, so a Grok agent ran GLM unless a
--      concrete id was pinned.
--   2. That Grok alone among them can be funded by a customer's own key. An
--      OpenRouter invoice is Liftoff's, so an xAI key cannot settle it, and
--      funding a turn meant leaving OpenRouter mid-run.
--   3. Its rates, which were read from OpenRouter's list because that is where
--      it billed.
--
-- The registry provider key stays 'grok' — that is the vendor key migrations 322
-- and 380 created so a new vendor cannot displace GLM as OpenRouter's tier map,
-- and it is unrelated to the execution provider, which is what changed.

-- RLS. `internal_agents` and `model_configs` are both FORCE row-level-security,
-- and this migration rewrites rows across every tenant, so no single tenant
-- scope could be bound for it. Migrations run as liftoff_app, which owns both
-- tables, so dropping FORCE for the length of this transaction is the owner's
-- equivalent of the admin pool's BYPASSRLS. ALTER TABLE holds ACCESS EXCLUSIVE
-- until COMMIT, so no other session observes either table unforced. Same shape
-- as migrations 383 and 384.
--
-- Without this the migration does not run at all: the policies read
-- `current_setting('app.current_tenant_id', ...)`, which in a migration session
-- was never set, and Postgres raises
-- `unrecognized configuration parameter "app.current_tenant_id"`.
-- (`models` is not RLS at all, so it needs nothing.)

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   NO FORCE ROW LEVEL SECURITY;

UPDATE models
   SET model_id = regexp_replace(model_id, '^x-ai/', ''),
       updated_at = NOW()
 WHERE provider = 'grok'
   AND model_id LIKE 'x-ai/%';

-- Agents already configured for Grok carry the slug in their model_config, and
-- the runtime copies that verbatim. Left alone, every one of them would ask
-- api.x.ai for a model it has never heard of.
--
-- Both halves are rewritten together: the provider, which is what selects the
-- adapter, and the model id, which is what that adapter sends. Writing one
-- without the other is the exact shape of the defect this whole change removes.
UPDATE internal_agents
   SET model_config = jsonb_set(
         jsonb_set(model_config, '{modelId}',
                   to_jsonb(regexp_replace(model_config->>'modelId', '^x-ai/', ''))),
         '{provider}', '"xai"'),
       updated_at = NOW()
 WHERE model_config->>'modelId' LIKE 'x-ai/%';

-- A workspace whose routing policy pins Grok, same reasoning. The policy lives
-- on model_configs.routing_policy, and it carries model ids in three places:
-- defaultModel, taskOverrides (per background task) and providerOverrides.
--
-- Both halves are rewritten together — the provider, which selects the adapter,
-- and the model id, which is what that adapter sends. Writing one without the
-- other is the exact shape of the defect this whole change removes.
UPDATE model_configs
   SET routing_policy = jsonb_set(
         routing_policy,
         '{defaultModel}',
         to_jsonb(regexp_replace(routing_policy->>'defaultModel', '^x-ai/', ''))),
       updated_at = NOW()
 WHERE routing_policy->>'defaultModel' LIKE 'x-ai/%';

UPDATE model_configs
   SET routing_policy = jsonb_set(routing_policy, '{defaultProvider}', '"xai"'),
       updated_at = NOW()
 WHERE routing_policy->>'defaultProvider' = 'openrouter'
   AND routing_policy->>'defaultModel' LIKE 'grok-%';

-- The per-task halves. A Grok workspace stamps BOTH model and provider per
-- background task (buildWorkspaceAiPolicy writes them together, deliberately,
-- because tenant-runtime resolves providerOverrides[task] || defaultProvider).
-- Rewriting the models without the providers would leave each task asking
-- OpenRouter for a model it no longer serves.
UPDATE model_configs mc
   SET routing_policy = jsonb_set(
         mc.routing_policy,
         '{taskOverrides}',
         (SELECT jsonb_object_agg(k, to_jsonb(regexp_replace(v #>> '{}', '^x-ai/', '')))
            FROM jsonb_each(mc.routing_policy->'taskOverrides') AS t(k, v))),
       updated_at = NOW()
 WHERE mc.routing_policy->'taskOverrides' IS NOT NULL
   AND mc.routing_policy::text LIKE '%x-ai/%';

UPDATE model_configs mc
   SET routing_policy = jsonb_set(
         mc.routing_policy,
         '{providerOverrides}',
         (SELECT jsonb_object_agg(k, CASE WHEN v #>> '{}' = 'openrouter'
                                          AND (mc.routing_policy->'taskOverrides'->>k) LIKE 'grok-%'
                                     THEN '"xai"'::jsonb ELSE v END)
            FROM jsonb_each(mc.routing_policy->'providerOverrides') AS t(k, v))),
       updated_at = NOW()
 WHERE mc.routing_policy->'providerOverrides' IS NOT NULL;

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   FORCE ROW LEVEL SECURITY;

COMMIT;
