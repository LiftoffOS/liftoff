-- Which people a Slack DM fan-out could not reach (C1).
--
-- Review and draft DMs fan out to every assignee. The result already knows who
-- was unreachable — a deactivated account, someone who never installed the app,
-- a DM the bot cannot open — but that list was returned to the HTTP caller and
-- discarded. So the same undeliverable person was retried on every notification
-- forever, burning flood-control budget, and nobody could answer "why did Ada
-- never see any of these?".
--
-- Teams already persists its fan-out results (review_teams_messages); this is
-- the Slack counterpart, and the input the dead-target registry will read when
-- it lands.
--
-- Self-healing by construction: a successful delivery overwrites the row, so
-- someone who installs the app later simply starts working again with no
-- cleanup.

CREATE TABLE slack_dm_delivery_attempts (
  tenant_id          UUID NOT NULL REFERENCES tenants(id),
  assignee_account_id UUID NOT NULL,
  -- 'review' | 'draft' — kept free-form rather than an enum so a new
  -- notification kind does not need a migration to be recorded.
  kind               TEXT NOT NULL,
  delivered          BOOLEAN NOT NULL,
  -- Why it failed, when it did. Bounded; never carries message content.
  failure_reason     TEXT,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at    TIMESTAMPTZ,

  PRIMARY KEY (tenant_id, assignee_account_id, kind)
);

CREATE INDEX idx_sdda_unreachable
  ON slack_dm_delivery_attempts (tenant_id, delivered)
  WHERE delivered = false;

ALTER TABLE slack_dm_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_dm_delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON slack_dm_delivery_attempts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
