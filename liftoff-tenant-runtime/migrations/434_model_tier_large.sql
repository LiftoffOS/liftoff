-- 434: the top model tier is named 'large' again.
--
-- Platform-backend migration 196 renamed the top tier from 'large' to
-- 'flagship'. It is renamed back because a Frontier designation now sits above
-- the ladder, and 'flagship' next to 'frontier' reads as two top tiers.
-- Frontier is not a tier and appears nowhere in this data.
--
-- The one place this database stores a tier is `agents.model_config.tier`, a
-- verbatim copy of the control plane's per-agent config. Found by reading every
-- writer of a tier-bearing field: no table has a tier column, no CHECK names a
-- tier, and resumed runs rebuild their context from `agents`, so no execution
-- snapshot holds one either.
--
-- Same pairing as migrations 399 and 433. The runtime translates the retired
-- name at read time too (normalizeTier in src/llm/types.ts), which covers a row
-- written AFTER this runs by a control plane not yet redeployed; this gives the
-- stored data a defined end. Left as written it would still resolve correctly,
-- but only for as long as that read-time translation exists.
--
-- `cached_model_configs.routing_policy` (defaultTier, taskTierOverrides) is NOT
-- rewritten: it is a cache of the control plane's policy, refreshed from it by
-- event and by the hourly reconciler, and the control plane renames its source
-- itself. Rewriting a cache in place is how a cache and its source start
-- disagreeing; the read-time translation covers it until it refreshes.
--
-- `agents` is not a row-level-security table in this database, so there is no
-- NO FORCE / FORCE wrapper (see 433).
--
-- Idempotent: scoped to rows that still say 'flagship'.

UPDATE agents
   SET model_config = jsonb_set(model_config, '{tier}', '"large"'::jsonb),
       updated_at   = NOW()
 WHERE model_config->>'tier' = 'flagship';
