-- Make the dead-target registry cover Teams as well as Slack.
--
-- Migration 321 recorded who a Slack DM fan-out could not reach, and the
-- registry built on it stops the platform retrying a confirmed-dead target
-- forever. Teams has exactly the same fan-out and exactly the same bug the
-- registry was built to fix: `postReviewCards` computes an `unreachable[]` list
-- and then DISCARDS it, so the same person with no conversation reference is
-- retried on every review, indefinitely, and nobody can answer "why has Ada
-- never seen any of these?".
--
-- Generalised rather than duplicated. A second `teams_..._attempts` table would
-- mean two schemas, two registries and two sets of threshold semantics that
-- have to agree — and the registry logic is already channel-agnostic (it reasons
-- about consecutive failures and self-heals on any success; nothing in it is
-- Slack-shaped). One table with a `channel` column is the smaller change and the
-- one that cannot drift.
--
-- The rename is safe: RLS policies, indexes and constraints follow the table,
-- and every reader of the old name ships in the same commit as this migration.

BEGIN;

ALTER TABLE slack_dm_delivery_attempts
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'slack';

-- Existing rows are all Slack by construction, which is what the default
-- encodes. Dropping it afterwards forces every new writer to say which channel
-- it is — the field is only useful if it cannot be omitted.
ALTER TABLE slack_dm_delivery_attempts
  ALTER COLUMN channel DROP DEFAULT;

-- The identity of a target is now (tenant, person, channel, kind): the same
-- person can be reachable on Slack and dead on Teams, and collapsing those
-- would let one channel's failures silence the other.
ALTER TABLE slack_dm_delivery_attempts
  DROP CONSTRAINT IF EXISTS slack_dm_delivery_attempts_pkey;
ALTER TABLE slack_dm_delivery_attempts
  ADD PRIMARY KEY (tenant_id, assignee_account_id, channel, kind);

ALTER TABLE slack_dm_delivery_attempts RENAME TO dm_delivery_attempts;

ALTER INDEX IF EXISTS idx_sdda_unreachable RENAME TO idx_dmda_unreachable;

COMMENT ON TABLE dm_delivery_attempts IS
  'Who a review/draft fan-out could not reach, per channel. Read by the dead-target registry so a confirmed-dead target is skipped rather than retried on every notification; any successful send un-latches it, so somebody who installs the app on Tuesday starts receiving on Tuesday with no cleanup job.';

COMMENT ON COLUMN dm_delivery_attempts.channel IS
  'slack | teams. Part of the key: the same person can be reachable on one and dead on the other, and collapsing them would let one channel''s failures silence the other.';

COMMIT;
