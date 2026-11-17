-- Migration 031: Fix all DB constraints blocking scheduled/event agent execution
-- Fixes threads.status check, actions/hitl FK requirements for scheduled invocations

BEGIN;

-- 1. Expand threads.status to include execution result statuses
ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_status_check;
ALTER TABLE threads ADD CONSTRAINT threads_status_check
  CHECK (status IN ('open', 'closed', 'archived', 'completed', 'failed', 'waiting_on_human'));

-- 2. Make workflow_id and task_id nullable on actions table
-- Scheduled/event-triggered executions don't create workflow/task rows upfront
ALTER TABLE actions ALTER COLUMN workflow_id DROP NOT NULL;
ALTER TABLE actions ALTER COLUMN task_id DROP NOT NULL;

-- Drop FK constraints on workflow_id/task_id if they exist
-- (scheduled invocations pass UUIDs that have no corresponding workflow/task rows)
ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_workflow_id_fkey;
ALTER TABLE actions DROP CONSTRAINT IF EXISTS actions_task_id_fkey;

-- 3. Same for hitl_approval_requests
ALTER TABLE hitl_approval_requests ALTER COLUMN workflow_id DROP NOT NULL;
ALTER TABLE hitl_approval_requests ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE hitl_approval_requests DROP CONSTRAINT IF EXISTS hitl_approval_requests_workflow_id_fkey;
ALTER TABLE hitl_approval_requests DROP CONSTRAINT IF EXISTS hitl_approval_requests_task_id_fkey;

COMMIT;
