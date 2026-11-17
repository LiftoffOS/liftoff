-- 366_hitl_approval_notification_outcome
-- Record whether the human was ever actually told an approval is waiting.
--
-- The gate is fail-closed; the message announcing it is fail-silent. When a gate
-- fires, TR writes the approval row, pauses the run, and fans a Slack DM / Teams
-- card out through `setImmediate(...)` — not awaited, and the result thrown away.
-- PB's fan-out already computes a per-recipient outcome (`{ totalAssignees,
-- delivered, unreachable[] }`) and hands it back; nothing has ever read it.
--
-- So a failed announcement left no trace but a `logger.warn`. Twenty-four hours
-- later the expiry path settled the run as failed and wrote `24h expiry — no
-- operator decision`, which is a statement about a PERSON — and it was written
-- identically whether they ignored the request or were never sent it.
--
-- `dm_delivery_attempts` (321/325) does not answer this. It is keyed
-- (tenant, assignee, kind, channel) and tracks whether a TARGET is healthy, so
-- it can say "this person has failed three times lately" and never "approval X
-- reached nobody".
--
-- Three nullable columns rather than a table: the fact is 1:1 with the approval,
-- is read on the same row the expiry path already loads, and a per-recipient
-- ledger would duplicate what `dm_delivery_attempts` already keeps.
--
-- NULL notify_attempted_at is meaningful and is NOT a failure: gates that are
-- not outbound-messaging and carry no generic card never push at all, because
-- the dashboard review queue is their surface. Distinguishing "never pushed"
-- from "pushed and reached nobody" is the entire point of these columns.

ALTER TABLE hitl_approval_requests
  ADD COLUMN IF NOT EXISTS notify_attempted_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS notify_delivered_count INTEGER,
  ADD COLUMN IF NOT EXISTS notify_target_count INTEGER,
  ADD COLUMN IF NOT EXISTS notify_error TEXT;

COMMENT ON COLUMN hitl_approval_requests.notify_attempted_at IS
  'When a push announcement (Slack DM / Teams card) was attempted for this approval. NULL means none was attempted — normal for non-messaging gates with no generic card, whose surface is the dashboard review queue.';
COMMENT ON COLUMN hitl_approval_requests.notify_delivered_count IS
  'Recipients the announcement actually reached. 0 with a non-NULL notify_attempted_at means the gate paused a run and told nobody.';
COMMENT ON COLUMN hitl_approval_requests.notify_target_count IS
  'Recipients the announcement was intended for. 0 means the assignee lookup returned nobody, which is a routing problem rather than a delivery one.';
COMMENT ON COLUMN hitl_approval_requests.notify_error IS
  'Failure from the announcement attempt, when it threw rather than returning counts.';

-- The query this exists to make possible: approvals that paused a run, tried to
-- tell somebody, and reached nobody. Partial so it stays small.
CREATE INDEX IF NOT EXISTS idx_hitl_approvals_announced_to_nobody
  ON hitl_approval_requests (tenant_id, created_at DESC)
  WHERE notify_attempted_at IS NOT NULL AND notify_delivered_count = 0;
