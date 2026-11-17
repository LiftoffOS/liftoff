-- The Qwen FLAGSHIP tier pointed at a model id that does not exist.
--
-- OpenRouter publishes this model only as `qwen/qwen3.8-max-0902` and serves no
-- bare `qwen/qwen3.8-max` for the undated form to resolve to, so every
-- tier-only request on Qwen flagship was a request for a model that is not
-- there, while medium and small worked. Qwen publishes THOSE two undated, which
-- is why the short form looks right here: each id is the vendor's own spelling,
-- not an instance of a pattern.
--
-- Same class as migration 419, and the same reason nothing caught it:
-- `scripts/ci/check-registry-drift.sh` asserts that a tier resolves to the SAME
-- id in the registry and in the seed, and both said `qwen/qwen3.8-max`.
-- Agreeing with each other is not the same as agreeing with the vendor.
-- Verified against OpenRouter's live model list, which carries
-- `qwen/qwen3.8-max-0902` (canonical `qwen/qwen3.8-max-20260902`) and no
-- undated sibling.
--
-- The context window is unchanged at 1,000,000 — the same figure the dated slug
-- publishes — so only the id moves.
--
-- Idempotent: every statement is keyed on the old id and matches nothing once
-- applied.

-- RLS. `internal_agents` and `model_configs` are FORCE row-level-security and
-- this rewrites rows across every tenant, so no single tenant scope could be
-- bound. Migrations run as liftoff_app, which owns both tables, so dropping
-- FORCE for the length of this transaction is the owner's equivalent of the
-- admin pool's BYPASSRLS; ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT, so no
-- other session observes either table unforced. Same shape as 417 and 419.
-- (`models` and `model_pricing` are not RLS, so they need nothing.)

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   NO FORCE ROW LEVEL SECURITY;

-- The registry row. Keyed on the id alone: the slug belongs to one vendor, and
-- `models` files it under the VENDOR key ('qwen') while `model_pricing` files it
-- under the EXECUTION provider ('openrouter'), so naming a provider here would
-- have to name a different one in each statement.
UPDATE models
   SET model_id = 'qwen/qwen3.8-max-0902',
       updated_at = NOW()
 WHERE model_id = 'qwen/qwen3.8-max';

-- The rate row follows the id. `computeRowCost` builds `provider:model`, so a
-- row left under the old id would be read by nothing once no request can name
-- that model — and an unmatched rate key does not fail, it records the tokens
-- at no cost.
UPDATE model_pricing
   SET model_id = 'qwen/qwen3.8-max-0902',
       source_slug = 'qwen/qwen3.8-max-0902',
       synced_at = NOW()
 WHERE model_id = 'qwen/qwen3.8-max';

-- An agent pinned to the dead id would keep asking for it.
UPDATE internal_agents
   SET model_config = jsonb_set(model_config, '{modelId}', '"qwen/qwen3.8-max-0902"'),
       updated_at = NOW()
 WHERE model_config->>'modelId' = 'qwen/qwen3.8-max';

UPDATE model_configs
   SET routing_policy = jsonb_set(routing_policy, '{defaultModel}', '"qwen/qwen3.8-max-0902"'),
       updated_at = NOW()
 WHERE routing_policy->>'defaultModel' = 'qwen/qwen3.8-max';

-- Selected by an EXACT value match rather than a LIKE over the whole policy.
-- The new id CONTAINS the old one as a substring, so a text match would still
-- fire after the rewrite above — and on a policy whose `taskOverrides` is an
-- empty object, `jsonb_object_agg` aggregates zero rows to NULL, which strict
-- `jsonb_set` turns into a NULL routing_policy. Matching the values themselves
-- cannot select a row it has nothing to change in; COALESCE covers the shape
-- regardless.
UPDATE model_configs mc
   SET routing_policy = jsonb_set(
         mc.routing_policy,
         '{taskOverrides}',
         COALESCE(
           (SELECT jsonb_object_agg(k, CASE WHEN v #>> '{}' = 'qwen/qwen3.8-max'
                                       THEN '"qwen/qwen3.8-max-0902"'::jsonb ELSE v END)
              FROM jsonb_each(mc.routing_policy->'taskOverrides') AS t(k, v)),
           mc.routing_policy->'taskOverrides')),
       updated_at = NOW()
 WHERE jsonb_typeof(mc.routing_policy->'taskOverrides') = 'object'
   AND EXISTS (
         SELECT 1 FROM jsonb_each(mc.routing_policy->'taskOverrides') AS t(k, v)
          WHERE v #>> '{}' = 'qwen/qwen3.8-max');

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   FORCE ROW LEVEL SECURITY;

COMMIT;
