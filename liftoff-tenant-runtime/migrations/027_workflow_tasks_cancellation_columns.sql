-- Migration 027: Add cancellation columns to workflow_tasks
-- Required for agent pause functionality

BEGIN;

-- Add tenant_id column for tenant isolation
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Add cancellation tracking columns
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- Create index for finding tasks to cancel when agent is paused
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_agent_tenant_status
ON workflow_tasks (agent_id, tenant_id, status)
WHERE status IN ('pending', 'running');

COMMIT;
