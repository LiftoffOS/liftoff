-- Migration 354: index the shapes the retention sweep predicates on.
--
-- workflow_escalations carries partial indexes for `status = 'pending'` lookups
-- only, because until now nothing ever asked about resolved rows or about age.
-- The sweep asks both, on every run, over the whole table:
--
--   1. system_internal still pending after 30 days  -> resolve with a marker
--   2. anything resolved longer than 30 days ago    -> delete
--
-- Without these, each pass is a sequential scan whose cost grows with the
-- history it is meant to be trimming: slowest exactly when it matters most.
--
-- Both are partial, so they index only the rows the sweep can act on and stay
-- small. Both are ordered by the column the sweep batches on, so the LIMITed
-- batch is a range read and the OLDEST rows go first — an unordered capped
-- sweep starves its own backlog, which is the bug the clarification-expiry
-- path already had to fix and this sweep must not reintroduce.

-- (1) The sweep of unresolved operator records.
CREATE INDEX idx_we_sweep_pending_internal
  ON workflow_escalations (created_at)
  WHERE status = 'pending' AND kind = 'system_internal';

-- (2) The deletion of long-resolved rows. Keyed on resolved_at, not created_at:
-- retention runs from when the record was CLOSED, so a long-running escalation
-- resolved yesterday is not deleted tomorrow because it was opened in April.
CREATE INDEX idx_we_sweep_resolved
  ON workflow_escalations (resolved_at)
  WHERE status = 'resolved';
