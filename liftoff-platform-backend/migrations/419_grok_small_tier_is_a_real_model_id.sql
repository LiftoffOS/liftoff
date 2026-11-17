-- The Grok SMALL tier pointed at a model id that does not exist.
--
-- Migration 380 registered the small tier as `x-ai/grok-4.20` and 417 rewrote it
-- to the native `grok-4.20`. Neither is a model api.x.ai serves. Its catalogue
-- has `grok-4.20-0309-reasoning`, `grok-4.20-0309-non-reasoning` and
-- `grok-4.20-multi-agent-0309`, and the bare id 404s — so every tier-only
-- request on Grok SMALL failed, managed and customer-funded alike, while
-- flagship and medium worked.
--
-- This is the failure `scripts/ci/check-registry-drift.sh` exists for and could
-- not catch: it asserts that a tier resolves to the SAME id in the registry and
-- in the seed, and both said `grok-4.20`. Agreeing with each other is not the
-- same as agreeing with the vendor. Verified against the live model list.
--
-- WHY NON-REASONING. Small buys SPEED — the 4.20 family is speed-optimised with
-- a 2M window and is listed at the same rate as grok-4.3, deliberately. The
-- reasoning variant spends latency and output tokens on exactly what this tier
-- is not for. Both dispatch tools correctly (probed live); multi-agent does not,
-- which is why migration 380 excluded it and this does not reconsider it.
--
-- Rates are unchanged: all three 4.20 variants are $1.25 / $0.20 / $2.50, and
-- $2.50 / $0.40 / $5.00 at or above 200k prompt tokens.

-- RLS. `internal_agents` and `model_configs` are FORCE row-level-security and
-- this rewrites rows across every tenant, so no single tenant scope could be
-- bound. Migrations run as liftoff_app, which owns both tables, so dropping
-- FORCE for the length of this transaction is the owner's equivalent of the
-- admin pool's BYPASSRLS; ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT, so no
-- other session observes either table unforced. Same shape as 417.
-- (`models` and `model_pricing` are not RLS, so they need nothing.)

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   NO FORCE ROW LEVEL SECURITY;

UPDATE models
   SET model_id = 'grok-4.20-0309-non-reasoning',
       updated_at = NOW()
 WHERE provider = 'grok'
   AND model_id = 'grok-4.20';

-- The rate row follows the id. `computeRowCost` builds `provider:model`, so a
-- row left under `xai:grok-4.20` would be read by nothing once no request can
-- name that model.
UPDATE model_pricing
   SET model_id = 'grok-4.20-0309-non-reasoning',
       source_slug = 'grok-4.20-0309-non-reasoning',
       synced_at = NOW()
 WHERE provider = 'xai'
   AND model_id = 'grok-4.20';

-- An agent or workspace pinned to the dead id would keep asking for it.
UPDATE internal_agents
   SET model_config = jsonb_set(model_config, '{modelId}', '"grok-4.20-0309-non-reasoning"'),
       updated_at = NOW()
 WHERE model_config->>'modelId' = 'grok-4.20';

UPDATE model_configs
   SET routing_policy = jsonb_set(routing_policy, '{defaultModel}', '"grok-4.20-0309-non-reasoning"'),
       updated_at = NOW()
 WHERE routing_policy->>'defaultModel' = 'grok-4.20';

UPDATE model_configs mc
   SET routing_policy = jsonb_set(
         mc.routing_policy,
         '{taskOverrides}',
         (SELECT jsonb_object_agg(k, CASE WHEN v #>> '{}' = 'grok-4.20'
                                     THEN '"grok-4.20-0309-non-reasoning"'::jsonb ELSE v END)
            FROM jsonb_each(mc.routing_policy->'taskOverrides') AS t(k, v))),
       updated_at = NOW()
 WHERE mc.routing_policy->'taskOverrides' IS NOT NULL
   AND mc.routing_policy::text LIKE '%grok-4.20%';

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   FORCE ROW LEVEL SECURITY;

COMMIT;
