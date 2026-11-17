-- Index the review queue the way it is now read: by tenant, newest first.
--
-- Why:
--
-- The queue is a three-arm UNION over hitl_approval_requests,
-- agent_scheduled_invocations and workflow_escalations, ordered by created_at
-- DESC and paginated with a composite keyset. Only the clarification arm had a
-- matching index — migration 264 gave agent_scheduled_invocations
-- (tenant_id, status, created_at DESC) with the objective in the predicate.
--
-- The other two arms sorted without one:
--
--   hitl_approval_requests  idx_hitl_approvals_pending (tenant_id, status)
--                           -- no created_at
--   workflow_escalations    (tenant_id), (kind, status, agent_id),
--                           (tenant_id, agent_id, kind) -- none ordered
--
-- Without a sorted index per arm Postgres cannot MergeAppend three pre-sorted
-- scans, so every page materialises and sorts the tenant's entire pending set.
-- That is free at today's volumes (hundreds of rows) and stops being free
-- exactly when a tenant needs pagination most.
--
-- expires_at cannot join the index predicate: the actionability rule compares
-- it to NOW(), which is not IMMUTABLE, so a partial index cannot reference it.
-- It stays a filter, and INCLUDE carries it so the scan need not visit the heap.
--
-- Plain CREATE INDEX, not CONCURRENTLY: node-pg-migrate wraps each migration in
-- a transaction, and CONCURRENTLY cannot run inside one.

CREATE INDEX IF NOT EXISTS idx_hitl_approvals_queue
  ON hitl_approval_requests (tenant_id, created_at DESC)
  INCLUDE (expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS workflow_escalations_queue_idx
  ON workflow_escalations (tenant_id, created_at DESC)
  WHERE status = 'pending' AND kind = 'escalation';

-- The "decision window passed" view, which selects on expires_at and matches
-- neither partial index above (both are WHERE status='pending', and this view
-- spans pending-but-lapsed and swept-to-expired). hitl_approval_requests is the
-- fastest-growing of the three tables and is never pruned, so without this the
-- view sequential-scans the table on every open of the tab.
CREATE INDEX IF NOT EXISTS idx_hitl_approvals_passed
  ON hitl_approval_requests (tenant_id, expires_at DESC)
  WHERE status IN ('pending', 'expired');

-- The in-chat approval banner resolves the approval blocking one thread. It
-- used to scan the first hundred rows of the tenant's queue and miss anything
-- past that page; a thread lookup deserves an index rather than a haystack.
CREATE INDEX IF NOT EXISTS idx_hitl_approvals_thread
  ON hitl_approval_requests (tenant_id, thread_id)
  WHERE status = 'pending' AND thread_id IS NOT NULL;
