-- Migration 303: Register Claude Opus 5 as the flagship Anthropic model
--
-- Additive upgrade of the Opus line. Opus 5 (`claude-opus-5`) succeeds Opus 4.8
-- at identical pricing and the same API surface (adaptive-thinking-only). The
-- code-level flagship pointer (providers TIER_MODELS, pricing, branding) moved
-- to Opus 5 in the same change; this lands the matching row in the global,
-- non-RLS `models` catalog so tier-based routing resolution stays consistent.
--
-- `ModelRepository.findByTierAndProvider('flagship','anthropic')` selects the
-- newest approved flagship row (ORDER BY created_at DESC LIMIT 1), so this
-- upsert makes Opus 5 the resolved flagship for tenants whose routing policy
-- sets `defaultTier` without a `defaultModel`, and feeds the
-- model-registry-internal-router snapshot to tenant-runtime.
--
-- `models` is a GLOBAL non-RLS catalog (see repository.ts) → plain upsert; no
-- tenant scope, no FK/RLS traps. Idempotent via ON CONFLICT (model_id).
-- Existing rows (opus-4-7 etc.) are left in place — nothing is removed.

BEGIN;

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('Claude Opus 5', 'anthropic', 'claude-opus-5', 'flagship', 'approved',
   '["text-generation", "function-calling", "reasoning", "extended-thinking"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

COMMIT;
