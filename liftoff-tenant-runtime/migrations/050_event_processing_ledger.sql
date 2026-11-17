-- Event processing ledger: tracks every event delivery and its step-by-step completion.
-- Dedup key is (tenant_id, event_id) — tenant-scoped to prevent cross-tenant collisions.

CREATE TABLE event_processing_ledger (
    tenant_id       UUID NOT NULL,
    event_id        VARCHAR(255) NOT NULL,
    event_type      VARCHAR(255) NOT NULL,
    entity_type     VARCHAR(100) NOT NULL,
    entity_id       VARCHAR(255) NOT NULL,
    entity_version  INTEGER,
    status          VARCHAR(50) NOT NULL DEFAULT 'processing'
                    CHECK (status IN ('processing', 'completed', 'failed')),
    steps_completed JSONB NOT NULL DEFAULT '[]',
    result_metadata JSONB CHECK (result_metadata IS NULL OR length(result_metadata::text) <= 4096),
    error           TEXT CHECK (error IS NULL OR length(error) <= 1024),
    attempt_count   INTEGER NOT NULL DEFAULT 1,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (tenant_id, event_id)
);

-- Partial index for operational queries (stuck/failed events)
CREATE INDEX idx_epl_status ON event_processing_ledger(status) WHERE status != 'completed';
CREATE INDEX idx_epl_entity ON event_processing_ledger(tenant_id, entity_type, entity_id);
-- Prevent two events for the same entity from being processed concurrently
CREATE UNIQUE INDEX idx_epl_entity_processing
  ON event_processing_ledger(tenant_id, entity_type, entity_id)
  WHERE status = 'processing';

-- Idempotency key for compiled instructions
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
-- Tenant-scoped unique index to prevent cross-tenant collisions
CREATE UNIQUE INDEX IF NOT EXISTS idx_compiled_instructions_idempotency
  ON compiled_instructions(tenant_id, agent_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
