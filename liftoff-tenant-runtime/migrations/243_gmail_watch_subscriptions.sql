-- WS-9.2 — Gmail users.watch subscription tracking. Gmail watches expire
-- every 7 days; the re-arm cron refreshes via gmail-watch-rearm.

CREATE TABLE gmail_watch_subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  connector_id       uuid NOT NULL UNIQUE,    -- gmail connector instance
  gmail_user_id      text NOT NULL,           -- the Gmail "me" identity
  pubsub_topic       text NOT NULL,           -- projects/{ci}/topics/gmail-history-{env}
  history_id         text NOT NULL,           -- last known history id from Gmail
  watch_expires_at   timestamptz NOT NULL,    -- Gmail expires in 7 days
  re_armed_at        timestamptz NOT NULL DEFAULT NOW(),
  failure_count      integer NOT NULL DEFAULT 0
);

CREATE INDEX gws_expiring_soon ON gmail_watch_subscriptions (watch_expires_at)
  WHERE failure_count < 3;
