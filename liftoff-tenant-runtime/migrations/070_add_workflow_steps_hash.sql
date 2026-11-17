-- Add workflow_steps_hash column for execution-time tamper detection.
-- The platform-backend computes and pins this hash at agent creation/update time.
-- The executor verifies it before running a workflow.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS workflow_steps_hash TEXT;
