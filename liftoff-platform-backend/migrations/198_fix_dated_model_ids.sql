-- Migration 198: Correct mislabeled Claude 4 dated IDs in llm_usage_log.
--
-- Background: tenant-runtime DEFAULT_MODEL bugs (claude-opus-4-20250514 and
-- claude-sonnet-4-20250514) caused rows to be written with dated IDs when
-- the actual workload ran on canonical Opus 4.6 / Sonnet 4.6. Remap to
-- canonical so cost computation and reporting reflect reality.
--
-- This migration runs on the platform-backend DB. The matching tenant-runtime
-- DB migration (also numbered 198) handles per-tenant llm_usage_log rows.

BEGIN;

-- Snapshot for audit.
CREATE TABLE llm_usage_log_dated_id_backfill_198 AS
  SELECT id, model AS legacy_model, NOW() AS snapshot_at
  FROM llm_usage_log
  WHERE model IN ('claude-sonnet-4-20250514', 'claude-opus-4-20250514');

-- Remap to the canonical IDs that match the actual workload.
UPDATE llm_usage_log SET model = 'claude-sonnet-4-6' WHERE model = 'claude-sonnet-4-20250514';
UPDATE llm_usage_log SET model = 'claude-opus-4-6'   WHERE model = 'claude-opus-4-20250514';

COMMIT;
