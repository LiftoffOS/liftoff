-- Migration 534: the top routing tier is 'large' again.
--
-- This REVERSES migration 196. Migration 187 introduced the tier ladder as
-- small / medium / large; 196 renamed the top rung 'large' -> 'flagship'. It
-- goes back now because a "Frontier" designation sits above the top tier
-- (Claude Fable 5.1 / GPT-6 Astra, migration 529 and `frontier` in
-- src/model-registry/workspace-ai-vendors.ts), and "flagship" next to
-- "frontier" reads as two names for the same top slot. Frontier is NOT a
-- routing tier and is not added to the CHECK below: it has no `models.tier`
-- value (529 registers Fable with a NULL tier, which this migration leaves
-- alone, since `NULL IN (...)` passes a CHECK).
--
-- Every place a tier is STORED, in one transaction, so no reader ever sees
-- the two names mixed within one table:
--
--   1. models.tier (column + CHECK). Same pg_constraint lookup as 196: 187's
--      constraint was anonymous, and 196 named it models_tier_check, but a
--      lookup by definition survives either name.
--   2. model_configs.routing_policy: `defaultTier`, and each VALUE of
--      `taskTierOverrides` (task -> tier). These are the two tier-bearing keys
--      RoutingPolicy has (src/model-registry/types.ts); buildWorkspaceAiPolicy
--      and resolveTiersInPolicy write them and nothing else writes a tier into
--      the policy. `taskOverrides` / `defaultModel` hold model ids, not tiers.
--   3. internal_agents.model_config -> `tier`, and the same key in
--      internal_agent_versions.model_config (a restore copies a version's
--      model_config back onto the agent, so a stale version would reintroduce
--      the old name).
--
-- Found by reading every writer of a tier in src/ (the types LLMModelTier /
-- ModelTier / WorkspaceAiTier and every JSONB column they reach). The old
-- name is expected only in models.tier, not in stored JSON (chat, audit and
-- event-log history tables are excluded, since history is not rewritten), so
-- steps 2 and 3 may touch zero rows; they are here so the rename is complete
-- whatever a stored row holds. The internal_agents_modelconfig_pre_197 / internal_agent_versions_
-- modelconfig_pre_197 snapshot tables are 197's rollback copies of an older
-- state and are deliberately not rewritten.
--
-- Key-targeted jsonb_set, never a text replace over the whole document, so a
-- prompt or a name that happens to contain the word is untouched. Idempotent:
-- every UPDATE matches only rows still holding the old name, and the CHECK is
-- dropped by lookup and re-added, so a re-run changes nothing.
--
-- What this cannot reach, and what covers it: the tenant runtimes' own copies
-- (agents.model_config and the cached routing policy in each tenant database),
-- and events already in flight. model_configs changes re-publish through
-- trg_model_configs_emit_outbox (migration 263). For the rest, and for the
-- minutes of a deploy when platform-backend and the runtimes run different
-- versions, every read boundary maps the old name through normalizeTier
-- (src/llm/types.ts) before validating it.
--
-- RLS. internal_agents and model_configs are FORCE row-level security and this
-- rewrites rows across every tenant. Migrations run as liftoff_app, which owns
-- both, so FORCE is dropped for the length of the transaction; ALTER TABLE
-- holds ACCESS EXCLUSIVE until COMMIT, so no other session observes either
-- table unforced. Same shape as 417 and 450. models and internal_agent_versions
-- are not RLS-forced.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   NO FORCE ROW LEVEL SECURITY;

-- ── 1. models.tier ───────────────────────────────────────────────────────────
DO $$
DECLARE
  check_name TEXT;
BEGIN
  FOR check_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'models'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%tier%'
  LOOP
    EXECUTE format('ALTER TABLE models DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;

UPDATE models SET tier = 'large' WHERE tier = 'flagship';

ALTER TABLE models ADD CONSTRAINT models_tier_check
  CHECK (tier IN ('large', 'medium', 'small'));

-- ── 2. model_configs.routing_policy ──────────────────────────────────────────
UPDATE model_configs
   SET routing_policy = jsonb_set(routing_policy, '{defaultTier}', '"large"'::jsonb),
       updated_at = NOW()
 WHERE routing_policy->>'defaultTier' = 'flagship';

UPDATE model_configs mc
   SET routing_policy = jsonb_set(
         mc.routing_policy,
         '{taskTierOverrides}',
         (SELECT jsonb_object_agg(k, CASE WHEN v = '"flagship"'::jsonb THEN '"large"'::jsonb ELSE v END)
            FROM jsonb_each(mc.routing_policy->'taskTierOverrides') AS t(k, v))),
       updated_at = NOW()
 WHERE jsonb_typeof(mc.routing_policy->'taskTierOverrides') = 'object'
   AND EXISTS (
     SELECT 1 FROM jsonb_each(mc.routing_policy->'taskTierOverrides') AS t(k, v)
      WHERE v = '"flagship"'::jsonb
   );

-- ── 3. Agent model_config ────────────────────────────────────────────────────
UPDATE internal_agents
   SET model_config = jsonb_set(model_config, '{tier}', '"large"'::jsonb),
       updated_at = NOW()
 WHERE model_config->>'tier' = 'flagship';

UPDATE internal_agent_versions
   SET model_config = jsonb_set(model_config, '{tier}', '"large"'::jsonb)
 WHERE model_config->>'tier' = 'flagship';

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE model_configs   FORCE ROW LEVEL SECURITY;

COMMIT;
