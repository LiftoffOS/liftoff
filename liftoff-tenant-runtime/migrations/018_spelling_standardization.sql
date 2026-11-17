-- Standardize 'cancelled' → 'canceled' (American spelling)
-- Update workflow_tasks status values

UPDATE workflow_tasks
  SET status = 'canceled'
  WHERE status = 'cancelled';
