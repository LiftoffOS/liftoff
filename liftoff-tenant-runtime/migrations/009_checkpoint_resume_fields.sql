-- Migration 009: Add checkpoint resume fields
-- Per Section 7: Workflow checkpoint resume with idempotency
-- BLOCKING GAP: Required for checkpoint resume functionality

-- Add idempotency_key for deduplication of resumed workflows
ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- Add pending_tool_calls for tracking in-flight tool executions
ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS pending_tool_calls JSONB DEFAULT '[]';

-- Create unique index on idempotency_key for deduplication lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_checkpoints_idempotency
ON workflow_checkpoints(idempotency_key)
WHERE idempotency_key IS NOT NULL;

-- Index for finding checkpoints with pending tool calls
CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_pending_tools
ON workflow_checkpoints(workflow_id)
WHERE pending_tool_calls != '[]'::jsonb;
