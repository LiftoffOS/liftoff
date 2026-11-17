-- Migration 202: internal_agent_outbox for at-least-once event publishing
--
-- Background: internal-agents/events.ts:40-43 catches and swallows Pub/Sub
-- publish errors (typed wrapper publishInternalAgentEvent). The bare
-- publishEvent at events/publisher.ts:71 actually rethrows, but the typed
-- wrapper's swallow means the user-visible POST succeeds even when the
-- publish failed. Agent appears in PB but cannot be chatted with — the
-- NO_INSTRUCTION symptom.
--
-- Pattern mirrors migration 201 (provisioning_outbox) including the partial
-- unique index for enqueue-idempotency.

CREATE TABLE internal_agent_outbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- event_id is generated at enqueue time and REUSED on every publish retry.
  -- The runtime side dedupes via event_processing_ledger ON CONFLICT
  -- (tenant_id, event_id) at event-processor.ts. If we regenerated event_id on
  -- each retry, dedupe would never fire and a partially-published event could
  -- be processed multiple times.
  event_id          UUID NOT NULL DEFAULT gen_random_uuid(),

  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- FK with ON DELETE CASCADE: account-level cascade-delete (hard delete in
  -- accountService.cascadeDelete) cleans up any pending outbox rows for the
  -- deleted agent. User-initiated agent deletion is SOFT (deleted_at = NOW()),
  -- so the FK is not fired and the `deleted` event publishes normally.
  internal_agent_id UUID NOT NULL REFERENCES internal_agents(id) ON DELETE CASCADE,

  event_type        TEXT NOT NULL CHECK (event_type LIKE 'tenant.internal_agent.%'),
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

-- Worker polls due rows. Partial index so the planner only scans pending rows.
CREATE INDEX internal_agent_outbox_due
  ON internal_agent_outbox (status, next_attempt_at)
  WHERE status = 'pending';

-- Operator lookups per agent.
CREATE INDEX internal_agent_outbox_tenant_agent
  ON internal_agent_outbox (tenant_id, internal_agent_id);

-- Enqueue idempotency: prevent the same (tenant, agent, event_type) from
-- piling up if a caller transaction is retried.
CREATE UNIQUE INDEX internal_agent_outbox_unique_active
  ON internal_agent_outbox (tenant_id, internal_agent_id, event_type)
  WHERE status IN ('pending', 'in_progress');

-- No RLS — operator-only access via withAdminScope. Matches provisioning_outbox.
