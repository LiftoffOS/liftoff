-- Migration 198: Correct mislabeled and stale model IDs in llm_usage_log
--
-- Mirrors platform-backend migration 198 (Claude 4 dated-ID remap) and adds
-- Gemini 3.1 canonical-ID cleanup. Runs in every tenant DB via the standard
-- tenant-runtime migration pipeline.
--
-- Background:
--   * Tenant-runtime DEFAULT_MODEL bugs ('claude-sonnet-4-20250514',
--     'claude-opus-4-20250514') caused rows to be written with dated IDs
--     when the actual workload ran on canonical Opus 4.6 / Sonnet 4.6.
--   * pricing.ts has stale Gemini entries (2.5-pro, 2.5-flash, 2.0-flash);
--     the canonical set is the 3.1 family. Without remap, the pricing.ts
--     cleanup would orphan legacy rows (computeCost would return 0).
--
-- Pricing dollar amounts on the 3.1 set match the 2.x dollar amounts; this
-- migration fixes the model IDs only, preserving cost-row totals.

BEGIN;

CREATE TABLE llm_usage_log_legacy_id_backfill_198 AS
  SELECT id, model AS legacy_model, NOW() AS snapshot_at
  FROM llm_usage_log
  WHERE model IN (
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.0-flash'
  );

-- Anthropic dated-ID remap.
UPDATE llm_usage_log SET model = 'claude-sonnet-4-6' WHERE model = 'claude-sonnet-4-20250514';
UPDATE llm_usage_log SET model = 'claude-opus-4-6'   WHERE model = 'claude-opus-4-20250514';

-- Gemini stale-ID remap to canonical 3.1 set.
UPDATE llm_usage_log SET model = 'gemini-3.1-pro'        WHERE model = 'gemini-2.5-pro';
UPDATE llm_usage_log SET model = 'gemini-3.1-flash'      WHERE model = 'gemini-2.5-flash';
UPDATE llm_usage_log SET model = 'gemini-3.1-flash-lite' WHERE model = 'gemini-2.0-flash';

COMMIT;
