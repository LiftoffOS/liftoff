-- Migration 559: Register Claude Sonnet 5.5 as the medium-tier Anthropic model
--
-- Additive upgrade of the Sonnet line, the same shape migration 520 used for
-- Opus 5.5. Sonnet 5.5 (`claude-sonnet-5-5`) succeeds Sonnet 5 at the SAME price
-- ($2 / $10, both cache writes unchanged, cache read at the usual 10% of base
-- input) and keeps the 1M context window and 128K output ceiling. The code-level
-- pointer (providers TIER_MODELS, WORKSPACE_AI_VENDORS, pricing, branding) moves
-- to Sonnet 5.5 in the same change; this lands the matching row in the global,
-- non-RLS `models` catalog so tier-based routing resolution stays consistent.
--
-- `ModelRepository.findByTierAndProvider('medium','anthropic')` selects the
-- newest approved medium row (ORDER BY created_at DESC LIMIT 1), so this upsert
-- is what makes Sonnet 5.5 the resolved medium model for tenants whose routing
-- policy sets `defaultTier` without a `defaultModel`, and feeds the
-- model-registry-internal-router snapshot to tenant-runtime.
--
-- Sonnet 5 KEEPS its row and its 'medium' tier. It is no longer the newest, so
-- it no longer resolves — but a historic `llm_usage_log` row naming it must
-- still find a registry row, a rate and a context window. Nothing is removed;
-- the same reasoning migrations 303 and 520 applied to their predecessors.
--
-- `vision` is in the capability list FROM THE START. Migration 394 exists only
-- because migration 303 left it out and the inbound-media gate then answered
-- "cannot see" for the model most chat traffic runs on. A capability lookup that
-- cannot find its model answers no, so an omission here is not a missing nicety:
-- the medium tier is the busiest tier in this estate and it would silently
-- refuse images.
--
-- `models` is a GLOBAL non-RLS catalog (see repository.ts) -> plain upsert; no
-- tenant scope, no FK/RLS traps. Idempotent via ON CONFLICT (model_id).

BEGIN;

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('Claude Sonnet 5.5', 'anthropic', 'claude-sonnet-5-5', 'medium', 'approved',
   '["text-generation", "function-calling", "reasoning", "extended-thinking", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

-- The context window, on the same terms migrations 343 and 520 set: the vendor's
-- own published figure, and scoped `WHERE context_window IS NULL` so re-running
-- this — or applying it after an operator has corrected the value through
-- PUT /api/model-registry/:id/context-window — never overwrites a deliberate
-- entry with a historical one.
--
-- 1,000,000 per platform.claude.com/docs/en/models/sonnet-5-5/overview
-- (read 2026-09-28): unchanged from Sonnet 5.
--
-- THIS LINE IS NOT COSMETIC. An unsized model is not a model priced wrong, it is
-- a model bounded wrong: `contextWindowOrFallback` answers with the conservative
-- 128,000-token floor for any model the registry has no figure for, so omitting
-- this would close medium-tier turns at roughly a tenth of the window the model
-- actually has — and it is also what `check-registry-drift.sh` exits 1 on.
UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-sonnet-5-5' AND context_window IS NULL;

COMMIT;
