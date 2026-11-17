-- Migration 274: review_teams_messages
--
-- Loosely-coupled correlation: which Teams Adaptive Card review messages were
-- posted for which approval review. No FK to approval rows (those live in the
-- tenant-runtime DB). Mirrors migration 246's review_slack_messages. GC'd by a
-- daily cleanup job; 14-day retention. activity_id is the posted card's id so
-- sibling cards can be updated via updateActivity on approve/reject.

CREATE TABLE IF NOT EXISTS review_teams_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id             UUID NOT NULL,
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  assignee_account_id   UUID NOT NULL REFERENCES accounts(id),
  conversation_id       TEXT NOT NULL,
  activity_id           TEXT NOT NULL,
  posted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, activity_id)
);

CREATE INDEX IF NOT EXISTS idx_review_teams_messages_by_review
  ON review_teams_messages (review_id);

CREATE INDEX IF NOT EXISTS idx_review_teams_messages_by_conversation
  ON review_teams_messages (conversation_id);

-- Migration 095's tenant_isolation policy was a one-shot DO-loop; it does NOT
-- auto-apply to tables created afterwards. Enable RLS + create the policy
-- explicitly (same pattern as review_slack_messages, migration 246).
ALTER TABLE review_teams_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_review_teams_messages ON review_teams_messages;
CREATE POLICY tenant_isolation_review_teams_messages ON review_teams_messages
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE review_teams_messages IS
  'Correlation between approval review IDs (in tenant-runtime) and Teams Adaptive Card review messages. TTL 14 days via daily cleanup job.';
