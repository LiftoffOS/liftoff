-- 222: reactive subscriptions for predicate-driven agent triggering.
-- (Plan numbered 221; renumbered to 222 to avoid collision with
--  221_invocation_triggered_by_label.sql which ships in the same train.)

CREATE TABLE reactive_subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  agent_id             UUID NOT NULL,
  label                TEXT NOT NULL,
  source_kind          TEXT NOT NULL CHECK (source_kind IN ('connector_event', 'system_event', 'computed_metric')),
  source_spec          JSONB NOT NULL,
  filter_expr          JSONB,
  window_spec          JSONB,
  cooldown_seconds     INT NOT NULL DEFAULT 60 CHECK (cooldown_seconds BETWEEN 0 AND 86400),
  objective            TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'errored')),
  last_matched_at      TIMESTAMPTZ,
  last_error           TEXT,
  consecutive_errors   INT NOT NULL DEFAULT 0,
  next_poll_at         TIMESTAMPTZ,             -- only used when source_kind='computed_metric'
  poll_interval_seconds INT,                    -- only used when source_kind='computed_metric'
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_rs_unique ON reactive_subscriptions (tenant_id, agent_id, label);
CREATE INDEX idx_rs_active_connector ON reactive_subscriptions
  ((source_spec->>'connectorRef'), (source_spec->>'entityType'))
  WHERE status = 'active' AND source_kind = 'connector_event';
CREATE INDEX idx_rs_active_system ON reactive_subscriptions
  ((source_spec->>'topic'))
  WHERE status = 'active' AND source_kind = 'system_event';
CREATE INDEX idx_rs_due_metric ON reactive_subscriptions (next_poll_at)
  WHERE status = 'active' AND source_kind = 'computed_metric';

CREATE TABLE reactive_subscription_windows (
  subscription_id   UUID NOT NULL REFERENCES reactive_subscriptions(id) ON DELETE CASCADE,
  window_id         TEXT NOT NULL,
  count             BIGINT NOT NULL DEFAULT 0,
  sum_value         NUMERIC NOT NULL DEFAULT 0,
  min_value         NUMERIC,
  max_value         NUMERIC,
  expires_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (subscription_id, window_id)
);
CREATE INDEX idx_rsw_expiry ON reactive_subscription_windows (expires_at);

CREATE TABLE connector_entity_state (
  tenant_id    UUID NOT NULL,
  connector_id UUID NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  watched_paths JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, connector_id, entity_type, entity_id)
);
CREATE INDEX idx_ces_last_seen ON connector_entity_state (last_seen_at);

-- NOTIFY channel used by subscription-router to invalidate its in-memory cache.
CREATE FUNCTION rs_notify_reactive_subscriptions_changed() RETURNS trigger AS $$
DECLARE
  payload TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    payload := OLD.tenant_id::text || ':' || OLD.agent_id::text;
  ELSE
    payload := NEW.tenant_id::text || ':' || NEW.agent_id::text;
  END IF;
  PERFORM pg_notify('reactive_subscriptions_changed', payload);
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rs_reactive_subscriptions_changed
AFTER INSERT OR UPDATE OR DELETE ON reactive_subscriptions
FOR EACH ROW EXECUTE FUNCTION rs_notify_reactive_subscriptions_changed();
