-- Audit/test finding: hitl_approval_requests was created with a minimal schema in 001.
-- The service layer references 14 additional columns that were never added to the DB.
-- This migration brings the table in line with what service.ts expects.

ALTER TABLE hitl_approval_requests
  ADD COLUMN IF NOT EXISTS workflow_id        UUID,
  ADD COLUMN IF NOT EXISTS task_id            UUID,
  ADD COLUMN IF NOT EXISTS hitl_level         INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS pending_tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tool_calls_hash    TEXT,
  ADD COLUMN IF NOT EXISTS reason             TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key    TEXT,
  ADD COLUMN IF NOT EXISTS decided_by         TEXT,
  ADD COLUMN IF NOT EXISTS decided_by_role    TEXT,
  ADD COLUMN IF NOT EXISTS decision           TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason   TEXT,
  ADD COLUMN IF NOT EXISTS decided_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at         TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Back-fill created_at / updated_at from requested_at for rows that existed before this migration.
UPDATE hitl_approval_requests
  SET created_at = requested_at,
      updated_at = requested_at
  WHERE requested_at IS NOT NULL;

-- Unique constraint for idempotency key (only when set — NULLs are not considered duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS hitl_approval_requests_idempotency_key_unique
  ON hitl_approval_requests (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
