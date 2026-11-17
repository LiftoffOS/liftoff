-- Per-account notification queue. Powers realtime + digest delivery.
-- Cadence is snapshotted at enqueue so a user flipping daily→realtime mid-window
-- doesn't strand undelivered rows. Escalations always carry cadence='realtime'.

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('task_update','team_activity','escalation')),
  payload         JSONB NOT NULL,
  cadence         TEXT NOT NULL CHECK (cadence IN ('realtime','daily','weekly')),  -- 'none' rows are never inserted (short-circuit in enqueueNotification)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  delivery_error  TEXT
);

-- Hot path: digest job groups undelivered rows by account+cadence.
CREATE INDEX notifications_pending_for_digest
  ON notifications (account_id, cadence, created_at)
  WHERE delivered_at IS NULL;

-- Inbox view (future): account's recent rows newest-first.
CREATE INDEX notifications_account_created
  ON notifications (account_id, created_at DESC);

-- Dedupe table: prevents duplicate Tuesday performance-recap sends if the
-- hourly scheduler retries within the same hour.
CREATE TABLE notification_perf_recaps_sent (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL,                       -- Monday of the ISO week (in account's tz); stable week key independent of send day
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, week_start)
);

-- ── Defaults for notification preferences ──────────────────────────────────────
-- All users (new and existing) start with: every type ON, frequency='daily',
-- newsletter ON. Per product decision — engaged-by-default; users who want less
-- can opt down via Settings or per-email Unsubscribe.

-- 1. Set the column default so newly inserted accounts pick this up automatically.
ALTER TABLE accounts ALTER COLUMN preferences SET DEFAULT '{
  "notificationTypes": {
    "taskUpdates":  true,
    "teamActivity": true,
    "escalations":  true,
    "weeklyDigest": true
  },
  "notificationFrequency": "daily",
  "newsletter": true
}'::jsonb;

-- 2. Backfill existing accounts. Per-field COALESCE preserves any value the
-- user has already set; only ABSENT keys take the default. The trailing ||
-- preserves non-notification keys (e.g. `gettingStartedHidden`) that already
-- exist on the row.
UPDATE accounts SET preferences =
  jsonb_build_object(
    'notificationTypes', jsonb_build_object(
      'taskUpdates',  COALESCE((preferences->'notificationTypes'->>'taskUpdates')::boolean,  true),
      'teamActivity', COALESCE((preferences->'notificationTypes'->>'teamActivity')::boolean, true),
      'escalations',  COALESCE((preferences->'notificationTypes'->>'escalations')::boolean,  true),
      'weeklyDigest', COALESCE((preferences->'notificationTypes'->>'weeklyDigest')::boolean, true)
    ),
    'notificationFrequency', COALESCE(preferences->>'notificationFrequency', 'daily'),
    'newsletter',            COALESCE((preferences->>'newsletter')::boolean, true)
  )
  || COALESCE(preferences - 'notificationTypes' - 'notificationFrequency' - 'newsletter', '{}'::jsonb)
WHERE deleted_at IS NULL;
