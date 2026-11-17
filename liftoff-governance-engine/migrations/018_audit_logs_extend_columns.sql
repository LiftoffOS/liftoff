-- Migration 018: audit_logs schema/code alignment.
--
-- Background — service.ts extended the
-- INSERT INTO audit_logs to 17 columns: tenant_id, internal_agent_id,
-- user_id, thread_id, invocation_id, external_agent_id, action,
-- input_args, output_summary, outcome, error_code, triggered_by,
-- duration_ms, pre_action_snapshot, post_action_snapshot,
-- external_response, snapshot_status.
--
-- However, the migration that shipped with that commit (005) only added
-- two of those columns to the table (post_action_snapshot,
-- snapshot_status). The other thirteen never landed — leaving the table
-- with the legacy seven-column shape from migration 001:
--   (id, tenant_id, actor, action, target, metadata, created_at)
--
-- Consequence: without this migration every insertAuditLog() call
-- throws "column does not exist", and the per-action audit ledger
-- goes silently dark. Callers in
-- hitl-enforcement/service.ts and rpc/router.ts await the call without
-- a try/catch, so the failure propagates to a Connect-RPC 500.
--
-- This migration adds the thirteen missing columns. All nullable, all
-- IF NOT EXISTS, so this is safe under rolling deploy (the legacy
-- backfill-from-tenant.ts INSERT continues to use the legacy column
-- shape with extras packed into `metadata`, and the new shape is
-- additive).

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS internal_agent_id   UUID,
  ADD COLUMN IF NOT EXISTS user_id             UUID,
  ADD COLUMN IF NOT EXISTS thread_id           TEXT,
  ADD COLUMN IF NOT EXISTS invocation_id       TEXT,
  ADD COLUMN IF NOT EXISTS external_agent_id   TEXT,
  ADD COLUMN IF NOT EXISTS input_args          JSONB,
  ADD COLUMN IF NOT EXISTS output_summary      TEXT,
  ADD COLUMN IF NOT EXISTS outcome             TEXT,
  ADD COLUMN IF NOT EXISTS error_code          TEXT,
  ADD COLUMN IF NOT EXISTS triggered_by        TEXT,
  ADD COLUMN IF NOT EXISTS duration_ms         INTEGER,
  ADD COLUMN IF NOT EXISTS pre_action_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS external_response   JSONB;

-- Useful indexes for the new lookup paths (mirroring the per-tenant
-- pattern from migration 001). Created CONCURRENTLY-equivalent via
-- IF NOT EXISTS so re-runs are idempotent.
CREATE INDEX IF NOT EXISTS idx_audit_logs_invocation
  ON audit_logs (invocation_id)
  WHERE invocation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_thread
  ON audit_logs (thread_id)
  WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_internal_agent
  ON audit_logs (tenant_id, internal_agent_id, created_at DESC)
  WHERE internal_agent_id IS NOT NULL;
