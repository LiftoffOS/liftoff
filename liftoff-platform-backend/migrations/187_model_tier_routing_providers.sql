-- Migration 187: Model tiers + provider-aware routing policy
--
-- Adds tier (small/medium/large) to the models table so the model registry
-- can resolve tier references to concrete model IDs at config-write time.
-- The routing policy stored in model_configs is always in resolved form
-- (concrete model IDs) so tenant-runtime cache consumers never need to
-- understand tiers.
--
-- Also registers the approved Anthropic model set with correct tiers and
-- migrates all existing model_configs to tier-based routing with Anthropic
-- as the default provider.

BEGIN;

-- Add tier column to models
ALTER TABLE models ADD COLUMN IF NOT EXISTS tier TEXT CHECK (tier IN ('small', 'medium', 'large'));

-- model_id must be unique for ON CONFLICT (model_id) to work.
-- The initial schema did not add this constraint; add it idempotently.
CREATE UNIQUE INDEX IF NOT EXISTS models_model_id_key ON models (model_id);

-- Register approved Anthropic models with tiers.
-- ON CONFLICT on model_id so this is safe to re-run.
INSERT INTO models (name, provider, model_id, tier, status, capabilities)
VALUES
  ('Claude Haiku 4.5',  'anthropic', 'claude-haiku-4-5-20251001', 'small',  'approved',
   '["text-generation", "function-calling"]'::jsonb),
  ('Claude Sonnet 4.6', 'anthropic', 'claude-sonnet-4-6',         'medium', 'approved',
   '["text-generation", "function-calling", "reasoning"]'::jsonb),
  ('Claude Opus 4.7',   'anthropic', 'claude-opus-4-7',           'large',  'approved',
   '["text-generation", "function-calling", "reasoning", "extended-thinking"]'::jsonb)
ON CONFLICT (model_id) DO UPDATE SET
  tier       = EXCLUDED.tier,
  status     = EXCLUDED.status,
  updated_at = NOW();

-- Replace all existing model_configs routing policies with tier-based config.
-- Stores both the tier intent AND the resolved model IDs so tenant-runtime
-- cache reads concrete model IDs without needing its own tier resolver.
-- Background tasks (hyde, consolidation, suggestion, extraction, tabular) → small.
-- Agent execution default → medium.
UPDATE model_configs
SET routing_policy = jsonb_build_object(
  'defaultProvider',    'anthropic',
  'defaultTier',        'medium',
  'defaultModel',       'claude-sonnet-4-6',
  'taskTierOverrides',  '{"retrieval_hyde":"small","memory_consolidation":"small","suggestion_applier":"small","chat-feedback-extraction":"small","tabular_extract":"small"}'::jsonb,
  'taskOverrides',      '{"retrieval_hyde":"claude-haiku-4-5-20251001","memory_consolidation":"claude-haiku-4-5-20251001","suggestion_applier":"claude-haiku-4-5-20251001","chat-feedback-extraction":"claude-haiku-4-5-20251001","tabular_extract":"claude-haiku-4-5-20251001"}'::jsonb
),
updated_at = NOW();

-- Point all existing model_configs at the Anthropic Sonnet model row.
-- model_id is a FK to models.id; find the newly inserted Sonnet row.
UPDATE model_configs mc
SET model_id = m.id
FROM models m
WHERE m.model_id = 'claude-sonnet-4-6'
  AND m.status   = 'approved';

COMMIT;
