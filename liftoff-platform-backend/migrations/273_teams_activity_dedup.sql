-- Migration 273: teams_activity_dedup
--
-- Bot Framework can re-deliver an Activity; dedup on activity.id before
-- processing. Global (no tenant_id, no RLS) — mirrors slack_event_dedup
-- (migration 106). Cleaned by a scheduled TTL job (received_at index).

CREATE TABLE teams_activity_dedup (
  activity_id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tad_ttl ON teams_activity_dedup (received_at);
