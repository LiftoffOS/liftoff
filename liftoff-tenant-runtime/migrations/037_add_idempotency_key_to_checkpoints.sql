-- Migration 037: Add idempotency_key to workflow_checkpoints
-- Required by coordinator.commitTransition() ON CONFLICT clause

ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_checkpoints_idempotency
  ON workflow_checkpoints (idempotency_key) WHERE idempotency_key IS NOT NULL;
