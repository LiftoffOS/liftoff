-- Migration 029: Add 'scheduler' and 'event' to threads initiated_by_type check constraint
-- Required for Cloud Scheduler and event-driven agent invocations

BEGIN;

-- Drop the existing check constraint
ALTER TABLE threads DROP CONSTRAINT IF EXISTS threads_initiated_by_type_check;

-- Re-create with expanded values
ALTER TABLE threads ADD CONSTRAINT threads_initiated_by_type_check
  CHECK (initiated_by_type IN ('human', 'agent', 'system', 'scheduler', 'event'));

COMMIT;
