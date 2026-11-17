-- Migration 203: control_plane_outbox for at-least-once delivery of all
-- non-internal_agent control-plane events (tenant.activated, tenant.connector.*,
-- tenant.entitlement.updated, tenant.suspended, tenant.model_config.updated,
-- tenant.prompt_bundle.updated, account.*, model.*, compliance.*, …).
--
-- Distinct table from internal_agent_outbox because entity_id here is opaque
-- text (could be tenant_id, connector_id, account_id, …) so we cannot have a
-- FK constraint. Same lifecycle/columns otherwise.

CREATE TABLE control_plane_outbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Persisted at enqueue, reused on every publish retry — same rationale as
  -- internal_agent_outbox.event_id (runtime dedupe via event_processing_ledger).
  event_id          UUID NOT NULL DEFAULT gen_random_uuid(),

  tenant_id         UUID REFERENCES tenants(id) ON DELETE CASCADE,  -- nullable for cross-tenant events (account.*, model.approved, …)
  entity_type       TEXT NOT NULL,
  entity_id         TEXT NOT NULL,

  -- CHECK constraint intentionally broad: ~30 non-tenant event types use this
  -- code path. The dispatcher in publisher.ts routes internal_agent events to
  -- internal_agent_outbox; everything else lands here.
  event_type        TEXT NOT NULL,
  event_payload     JSONB NOT NULL,
  entity_version    INTEGER,

  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 10,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX control_plane_outbox_due
  ON control_plane_outbox (status, next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX control_plane_outbox_entity
  ON control_plane_outbox (entity_type, entity_id);

-- Enqueue idempotency: prevent the same (entity_type, entity_id, event_type)
-- from piling up on caller-tx retry. Same pattern as internal_agent_outbox.
CREATE UNIQUE INDEX control_plane_outbox_unique_active
  ON control_plane_outbox (entity_type, entity_id, event_type)
  WHERE status IN ('pending', 'in_progress');

-- No RLS — operator-only via withAdminScope. Matches other outboxes.
