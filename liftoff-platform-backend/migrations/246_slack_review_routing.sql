-- Cache of Liftoff account → Slack user resolution per workspace.
-- Populated lazily by identity-resolver.resolveSlackIdentity; refreshed after 7 days.
-- No FK to slack_team_id (it's a Slack-side identifier, not a row of ours).
CREATE TABLE IF NOT EXISTS account_slack_identities (
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slack_team_id   TEXT NOT NULL,
  slack_user_id   TEXT NOT NULL,
  resolved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, slack_team_id)
);

CREATE INDEX IF NOT EXISTS idx_account_slack_identities_reverse
  ON account_slack_identities (slack_team_id, slack_user_id);

-- RLS: this table has no tenant_id column, so the global tenant_isolation
-- policy (migration 095) does NOT apply. We add an explicit permissive
-- policy because the table contains no tenant-confidential data — knowing
-- an account_id maps to a Slack user requires already having the account_id,
-- which itself is protected by upstream RLS-scoped joins. All access goes
-- through withAdminScope (no current_tenant_id set).
ALTER TABLE account_slack_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_only_access ON account_slack_identities
  USING (true)
  WITH CHECK (true);

-- Loosely-coupled correlation: which Slack DM messages were posted for which
-- approval review. No FK to approval rows (those live in tenant-runtime DB).
-- GC'd by a daily cleanup job; 14-day retention.
CREATE TABLE IF NOT EXISTS review_slack_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id             UUID NOT NULL,
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  assignee_account_id   UUID NOT NULL REFERENCES accounts(id),
  slack_team_id         TEXT NOT NULL,
  slack_dm_channel_id   TEXT NOT NULL,
  slack_dm_root_ts      TEXT NOT NULL,
  posted_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slack_team_id, slack_dm_channel_id, slack_dm_root_ts)
);

CREATE INDEX IF NOT EXISTS idx_review_slack_messages_by_review
  ON review_slack_messages (review_id);

CREATE INDEX IF NOT EXISTS idx_review_slack_messages_by_thread
  ON review_slack_messages (slack_team_id, slack_dm_channel_id, slack_dm_root_ts);

-- Migration 095's tenant_isolation policy was a one-shot DO-loop over
-- information_schema.columns; it does NOT auto-apply to tables created
-- afterwards (see migration 200's preamble for the canonical explanation).
-- Every later migration that adds a tenant_id table must enable RLS and
-- create the policy explicitly. Mirror the pattern from migrations 097/218.
ALTER TABLE review_slack_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_review_slack_messages ON review_slack_messages;
CREATE POLICY tenant_isolation_review_slack_messages ON review_slack_messages
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE review_slack_messages IS
  'Correlation between approval review IDs (in tenant-runtime) and Slack DM card thread roots. TTL 14 days via daily cleanup job.';
