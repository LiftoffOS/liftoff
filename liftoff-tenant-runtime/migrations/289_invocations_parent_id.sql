-- 1.5 — delegated-children billing: link a child invocation to the orchestrator
-- invocation that spawned it (delegate_to_agent), so cost-attribution dashboards
-- can trace delegation trees and /activity can render parent → child.
-- Additive + nullable: harmless before the BILL_DELEGATED_CHILDREN code path ships.
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS parent_invocation_id uuid;
CREATE INDEX IF NOT EXISTS idx_invocations_parent
  ON invocations(parent_invocation_id) WHERE parent_invocation_id IS NOT NULL;
