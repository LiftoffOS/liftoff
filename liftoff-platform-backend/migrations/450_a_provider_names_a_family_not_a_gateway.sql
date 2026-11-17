-- 450: a provider names a model family. OpenRouter is a gateway, and a gateway is
-- not a family.
--
-- GLM, Qwen, DeepSeek and Kimi are all reached through OpenRouter, and all four
-- were stored as provider 'openrouter'. The runtime resolves an adapter and a
-- tier map from that value, and there is exactly one of each per provider — so
-- a workspace set to Qwen resolved OpenRouter's tier map and ran GLM. That is
-- the defect migration 417 moved Grok out for; the other four stayed behind
-- because nothing had yet given them names of their own.
--
-- Three vocabularies collapse into one here. `models.provider` (the registry
-- key), `invocations.provider` / `model_config.provider` (the execution key)
-- and the pricing key prefix are now the same value, which is what makes a
-- registry row reach the runtime at all: the runtime builds its lookup as
-- `provider:model_id`, so a row filed under a key the runtime never resolves is
-- read by nothing. Grok's rows were filed under 'grok' and looked up under
-- 'xai' — its registry-sourced context windows, which exist nowhere else,
-- reached the runtime under a key nothing read.
--
-- THE FAMILY COMES FROM THE MODEL ID, not from a per-row decision. These ids
-- are OpenRouter slugs and carry their publisher (`z-ai/`, `qwen/`,
-- `deepseek/`, `moonshotai/`), which is the same derivation the code does in
-- model-family.ts. A row with no recognisable publisher becomes GLM, because
-- GLM is what the gateway name resolved to before this migration and moving it
-- anywhere else would change which model that configuration runs.
--
-- Model ids are NOT rewritten. Unlike Grok, these four still execute on
-- OpenRouter, so the namespaced slug is still exactly what the endpoint serves.
-- Only the provider was wrong.
--
-- RLS. `internal_agents` and `model_configs` are both FORCE row-level-security
-- and this rewrites rows across every tenant, so no single tenant scope could
-- be bound. Migrations run as liftoff_app, which owns both tables, so dropping
-- FORCE for the length of this transaction is the owner's equivalent of the
-- admin pool's BYPASSRLS; ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT, so
-- no other session observes either table unforced. Same shape as 383, 384, 417.
-- (`models` and `model_pricing` are not RLS at all.)

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   NO FORCE ROW LEVEL SECURITY;

-- ── The registry ────────────────────────────────────────────────────────────
-- GLM's rows were seeded under the runtime key (migration 284) before the
-- per-vendor keys existed, so 'openrouter' here has only ever meant GLM.
UPDATE models
   SET provider = 'glm', updated_at = NOW()
 WHERE provider = 'openrouter';

-- Grok's rows were filed under the vendor key while it executes as 'xai'
-- (migration 417 kept the split deliberately; it is the half that turned out to
-- cost something).
UPDATE models
   SET provider = 'xai', updated_at = NOW()
 WHERE provider = 'grok';

-- ── Synced rates ────────────────────────────────────────────────────────────
-- sync-model-pricing wrote every gateway-served rate under 'openrouter', so the
-- rows for the other three are present, correct, and looked up under a key they
-- are not filed at. The lookup falls through to the static table, which carries
-- no conditional bands for them — the reprice a sync exists to deliver never
-- lands. Same derivation: publisher decides.
UPDATE model_pricing SET provider = 'qwen'     WHERE provider = 'openrouter' AND model_id LIKE 'qwen/%';
UPDATE model_pricing SET provider = 'deepseek' WHERE provider = 'openrouter' AND model_id LIKE 'deepseek/%';
UPDATE model_pricing SET provider = 'kimi'     WHERE provider = 'openrouter' AND model_id LIKE 'moonshotai/%';
UPDATE model_pricing SET provider = 'glm'      WHERE provider = 'openrouter';

-- ── Agent configuration ─────────────────────────────────────────────────────
-- The runtime copies model_config verbatim and resolves its adapter from
-- `provider`. Left alone, every agent on one of these four keeps resolving
-- OpenRouter's single tier map.
UPDATE internal_agents
   SET model_config = jsonb_set(model_config, '{provider}',
         CASE
           WHEN model_config->>'modelId' LIKE 'qwen/%'       THEN '"qwen"'::jsonb
           WHEN model_config->>'modelId' LIKE 'deepseek/%'   THEN '"deepseek"'::jsonb
           WHEN model_config->>'modelId' LIKE 'moonshotai/%' THEN '"kimi"'::jsonb
           ELSE '"glm"'::jsonb
         END),
       updated_at = NOW()
 WHERE model_config->>'provider' = 'openrouter';

-- ── Workspace routing policy ────────────────────────────────────────────────
-- The policy names a provider twice: once as the default, and once per
-- background task in providerOverrides. buildWorkspaceAiPolicy writes model and
-- provider together for each task, and the runtime resolves
-- `providerOverrides[task] || defaultProvider` — so rewriting only the default
-- would leave each task on the gateway name while the workspace moved off it.
UPDATE model_configs
   SET routing_policy = jsonb_set(routing_policy, '{defaultProvider}',
         CASE
           WHEN routing_policy->>'defaultModel' LIKE 'qwen/%'       THEN '"qwen"'::jsonb
           WHEN routing_policy->>'defaultModel' LIKE 'deepseek/%'   THEN '"deepseek"'::jsonb
           WHEN routing_policy->>'defaultModel' LIKE 'moonshotai/%' THEN '"kimi"'::jsonb
           ELSE '"glm"'::jsonb
         END),
       updated_at = NOW()
 WHERE routing_policy->>'defaultProvider' = 'openrouter';

-- Each task's provider follows THAT task's model, which is not always the
-- default one: taskOverrides can pin a different model per task, and a policy
-- whose default is GLM may still route one task to a Qwen coder id.
UPDATE model_configs mc
   SET routing_policy = jsonb_set(
         mc.routing_policy,
         '{providerOverrides}',
         (SELECT jsonb_object_agg(k,
                   CASE WHEN v #>> '{}' <> 'openrouter' THEN v
                        WHEN (mc.routing_policy->'taskOverrides'->>k) LIKE 'qwen/%'       THEN '"qwen"'::jsonb
                        WHEN (mc.routing_policy->'taskOverrides'->>k) LIKE 'deepseek/%'   THEN '"deepseek"'::jsonb
                        WHEN (mc.routing_policy->'taskOverrides'->>k) LIKE 'moonshotai/%' THEN '"kimi"'::jsonb
                        -- No per-task model pinned: the task runs the policy
                        -- default, so it belongs to whatever family that is.
                        WHEN (mc.routing_policy->'taskOverrides'->>k) IS NULL
                          THEN to_jsonb(mc.routing_policy->>'defaultProvider')
                        ELSE '"glm"'::jsonb
                   END)
            FROM jsonb_each(mc.routing_policy->'providerOverrides') AS t(k, v))),
       updated_at = NOW()
 WHERE mc.routing_policy->'providerOverrides' IS NOT NULL
   AND mc.routing_policy->'providerOverrides' @> '{}'::jsonb
   AND EXISTS (
     SELECT 1 FROM jsonb_each(mc.routing_policy->'providerOverrides') AS t(k, v)
      WHERE v #>> '{}' = 'openrouter'
   );

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   FORCE ROW LEVEL SECURITY;

COMMIT;
