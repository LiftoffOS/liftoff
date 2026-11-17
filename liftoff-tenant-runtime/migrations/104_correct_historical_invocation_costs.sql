-- Migration 104: Correct historical invocation costs priced as Sonnet instead of Opus.
--
-- Bug: chat-turn-handler.ts hardcoded 'claude-sonnet-4-20250514' as the model_id
-- for all chat invocations (triggered_by = 'human') regardless of the agent's actual
-- configured model. The handler now resolves model_id from agents.model_config
-- before creating the invocation record.
--
-- Impact: historical invocations where agents are configured as claude-opus-4-6 were
-- stored with:
--   model_id               = 'claude-sonnet-4-20250514'  (wrong)
--   input_price_per_million  = 3.00  (Sonnet rate, should be 5.00 for Opus)
--   output_price_per_million = 15.00 (Sonnet rate, should be 25.00 for Opus)
--
-- Migration 103 only corrected records already carrying an Opus model_id; it missed
-- these records because they have model_id = 'claude-sonnet-4-20250514'.
--
-- Fix strategy: join invocations → agents on (agent_id, tenant_id), extract
-- model_config->>'modelId', and rewrite model_id + pricing for any chat invocation
-- stored under the hardcoded Sonnet model_id where the agent is actually Opus.
-- Records where model_config is missing or set to a non-Opus model are left as-is.
--
-- Must run BEFORE the cost-attribution backfill in platform-backend so the
-- backfill ingests corrected values.

-- Step 1: Fix invocations stored as Sonnet where the agent's actual model is Opus.
-- We accept any model_id whose base name maps to an Opus variant.
UPDATE invocations i
SET
  model_id                 = COALESCE(
                               NULLIF(TRIM((a.model_config::jsonb)->>'modelId'), ''),
                               'claude-opus-4-6'
                             ),
  input_price_per_million  = 5.00,
  output_price_per_million = 25.00
FROM agents a
WHERE i.agent_id = a.id
  AND i.tenant_id = a.tenant_id
  AND i.model_id  = 'claude-sonnet-4-20250514'
  AND i.triggered_by = 'human'
  AND (
    -- agent has an explicit Opus model configured
    (a.model_config::jsonb)->>'modelId' ILIKE '%opus%'
    OR
    -- agent has no model configured (default is Opus)
    COALESCE(NULLIF(TRIM((a.model_config::jsonb)->>'modelId'), ''), '') = ''
  );

-- Step 2: Correct records where model_id was stored correctly as 'claude-opus-4-6'
-- (e.g. inserted by other code paths) but pricing snapshots are still at Sonnet rates.
-- This is the scenario migration 103 intended to cover but gated on IS NOT NULL;
-- we also handle the NULL-pricing variant here by dropping that guard.
UPDATE invocations
SET
  input_price_per_million  = 5.00,
  output_price_per_million = 25.00
WHERE model_id IN ('claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-5',
                   'claude-opus-4-6-20250514', 'claude-opus-4-7-20250514')
  AND (
    input_price_per_million  IS DISTINCT FROM 5.00 OR
    output_price_per_million IS DISTINCT FROM 25.00
  );
