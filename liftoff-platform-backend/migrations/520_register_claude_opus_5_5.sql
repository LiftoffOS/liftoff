-- Migration 520: Register Claude Opus 5.5 as the flagship Anthropic model
--
-- Additive upgrade of the Opus line, the same shape as migration 303 did for
-- Opus 5. Opus 5.5 (`claude-opus-5-5`) succeeds Opus 5 at a LOWER price
-- ($4 / $20 against $5 / $25) and keeps the 1M context window and 128K output
-- ceiling. The code-level flagship pointer (providers TIER_MODELS,
-- WORKSPACE_AI_VENDORS, pricing, branding) moves to Opus 5.5 in the same
-- change; this lands the matching row in the global, non-RLS `models` catalog
-- so tier-based routing resolution stays consistent.
--
-- `ModelRepository.findByTierAndProvider('flagship','anthropic')` selects the
-- newest approved flagship row (ORDER BY created_at DESC LIMIT 1), so this
-- upsert makes Opus 5.5 the resolved flagship for tenants whose routing policy
-- sets `defaultTier` without a `defaultModel`, and feeds the
-- model-registry-internal-router snapshot to tenant-runtime.
--
-- Opus 5 KEEPS its row and its 'flagship' tier. It is no longer the newest, so
-- it no longer resolves — but a historic `llm_usage_log` row naming it must
-- still find a registry row, a rate and a context window. Nothing is removed;
-- the same reasoning migration 303 applied to opus-4-7.
--
-- `vision` is in the capability list FROM THE START. Migration 394 exists only
-- because migration 303 left it out and the inbound-media gate then answered
-- "cannot see" for the flagship model. A capability lookup that cannot find its
-- model answers no, so an omission here is not a missing nicety — it silently
-- refuses images on the tier most chat traffic runs on.
--
-- `models` is a GLOBAL non-RLS catalog (see repository.ts) → plain upsert; no
-- tenant scope, no FK/RLS traps. Idempotent via ON CONFLICT (model_id).

BEGIN;

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('Claude Opus 5.5', 'anthropic', 'claude-opus-5-5', 'flagship', 'approved',
   '["text-generation", "function-calling", "reasoning", "extended-thinking", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

-- The context window, on the same terms migration 343 set: the vendor's own
-- published figure, and scoped `WHERE context_window IS NULL` so re-running
-- this — or applying it after an operator has corrected the value through
-- PUT /api/model-registry/:id/context-window — never overwrites a deliberate
-- entry with a historical one.
--
-- 1,000,000 per platform.claude.com/docs/en/models/opus-5-5/overview
-- (read 2026-09-22): unchanged from Opus 5.
UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-opus-5-5' AND context_window IS NULL;

COMMIT;
