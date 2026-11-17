-- Migration 240: knowledge_outbox for at-least-once event publishing on
-- knowledge_items inserts. Mirror of 203_internal_agent_outbox.sql.
--
-- Purpose: drives the event-driven extract→embed pipeline by publishing
-- `knowledge.items.created` per row inserted into knowledge_items. The
-- existing standing crons (extract-knowledge-content-{env},
-- embed-knowledge-content-{env}) drop to hourly cadence as backstops.

CREATE TABLE knowledge_outbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  -- tenant_id is UUID matching tenants(id), same as 203_internal_agent_outbox.
  -- (Migration 241 converted knowledge_items.tenant_id from TEXT to UUID + FK
  -- so the parent column and this column are now type-aligned.)
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- FK with ON DELETE CASCADE: account-level cascade-delete cleans up any
  -- pending outbox rows for a deleted knowledge_item. Routine knowledge_item
  -- deletion is hard (no soft-delete column), so the FK fires reliably.
  item_id           UUID NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,

  event_type        TEXT NOT NULL CHECK (event_type LIKE 'knowledge.%'),
  event_payload     JSONB NOT NULL,
  entity_version    INTEGER,

  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 10,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX knowledge_outbox_due
  ON knowledge_outbox (status, next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX knowledge_outbox_tenant_item
  ON knowledge_outbox (tenant_id, item_id);

-- Enqueue idempotency: collapse repeated enqueues of (tenant, item, event_type)
-- while the prior one is still pending.
CREATE UNIQUE INDEX knowledge_outbox_unique_active
  ON knowledge_outbox (tenant_id, item_id, event_type)
  WHERE status IN ('pending', 'in_progress');
