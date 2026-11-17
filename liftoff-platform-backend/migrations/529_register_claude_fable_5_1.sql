-- Migration 529: Register Claude Fable 5.1, Anthropic's Frontier model.
--
-- "Frontier" is a new designation above the flagship, shown on the Workspace AI
-- card: Claude Fable 5.1 for Anthropic, GPT-6 Astra for OpenAI (owner
-- decision). It is a VENDOR DESIGNATION, NOT A ROUTING TIER, and nothing routes
-- to it yet. It lives in code, as `frontier` on each vendor in
-- WORKSPACE_AI_VENDORS (src/model-registry/workspace-ai-vendors.ts), and is
-- deliberately absent from `LLMModelTier`, `ModelTier`, `WorkspaceAiTier`,
-- TIER_MAP and the `models.tier` CHECK. This row gives the card a name to show
-- and gives a future route a registered, sized, priced model to reach.
--
-- TIER IS NULL, and that is the whole design, not a gap. Every tier reader
-- filters `tier IS NOT NULL`:
--
--   * `findByTierAndProvider` / the registry tier loader and the Workspace AI
--     vendor loader (DISTINCT ON (provider, tier) ORDER BY created_at DESC),
--   * the branding overlay and the tenant-runtime snapshot
--     (model-registry-internal-router.ts), which derive a codename from a tier.
--
-- So a NULL-tier row is invisible to all of them. Filed as 'flagship' it would
-- be the NEWEST approved Anthropic flagship and would displace Opus 5.5 on
-- every tier-only flagship request the moment the loaders refreshed: a silent
-- 2.5x price rise ($10 / $50 against $4 / $20) on the tier most chat traffic
-- runs on, which is exactly what "nothing routes to Frontier" rules out.
-- Migration 395 set the precedent: `text-embedding-004` is registered with a
-- NULL tier because it sits outside the chat ladder, and every tier consumer
-- skips it.
--
-- GPT-6 Astra needs no row here. It is one model holding two roles: OpenAI's
-- flagship tier (migration 527, unchanged) and its Frontier designation, which
-- is code-only and reads the name 527 already registered.
--
-- BRANDING. With no tier, the registry overlays cannot give this row a
-- codename; the static maps in src/branding/registry.ts (mirrored into
-- @liftoffos/shared-types) carry it instead, as 'cronus'.
--
-- ON CONFLICT NEVER TOUCHES TIER. 520 and 527 rewrite `tier` on conflict
-- because their tier IS the point. Here the reverse holds: if an operator later
-- files this row under a tier on purpose — the day Frontier starts routing — a
-- re-run of this migration must not quietly take that decision back.
--
-- CAPABILITIES are 520's list for Opus 5.5, spelled identically. `vision` is in
-- it from the start: migration 394 exists only because 303 left it out and the
-- inbound-media gate then answered "cannot see". Fable 5.1 takes image input.
--
-- WINDOW: 1,000,000, the vendor's published figure (platform.claude.com model
-- overview and pricing pages, read 2026-09-23; the 1M window is also the
-- default). Scoped `WHERE context_window IS NULL` exactly as 343, 520 and 527
-- are, so a re-run never overwrites a value an operator corrected through
-- PUT /api/model-registry/:id/context-window.
--
-- RATES are in src/llm/pricing.ts ($10 / $50; 5m cache write $12.50, 1h
-- $20, cache read $0.25 per platform.claude.com/docs/en/about-claude/pricing,
-- read 2026-09-23).
--
-- `models` is a GLOBAL non-RLS catalog (see repository.ts): plain upsert, no
-- tenant scope, no FK/RLS traps. Idempotent via ON CONFLICT (model_id).

BEGIN;

INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('Claude Fable 5.1', 'anthropic', 'claude-fable-5-1', NULL, 'approved',
   '["text-generation", "function-calling", "reasoning", "extended-thinking", "vision"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  status     = EXCLUDED.status,
  updated_at = NOW();

UPDATE models SET context_window = 1000000, updated_at = NOW()
 WHERE provider = 'anthropic' AND model_id = 'claude-fable-5-1' AND context_window IS NULL;

COMMIT;
