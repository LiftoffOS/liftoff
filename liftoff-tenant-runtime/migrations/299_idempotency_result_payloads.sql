-- Side-effect idempotency replay payloads (plan §4.2).
--
-- Per-side-effect idempotency claim/replay lives in event_processing_ledger
-- (event_type='side_effect', keyed event_id = step_key). But result_metadata
-- there is capped at 4096 chars, while a replayable tool result (a Gmail message
-- list, a Sheet read) routinely exceeds that. This side table holds the full
-- result payload for replay, keyed by step_key; the ledger row holds only status
-- + the step_key reference. 7-day TTL matches the ledger/redelivery window.
--
-- NOTE: migration number may need a bump on merge — this repo has many parallel
-- branches; renumber to the next free slot if 299 is taken upstream.

CREATE TABLE IF NOT EXISTS idempotency_result_payloads (
    step_key    VARCHAR(255) PRIMARY KEY,
    tenant_id   UUID NOT NULL,
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

-- Cheap range-delete target for the periodic prune (no separate sweeper needed;
-- the reconciler / a maintenance loop deletes WHERE expires_at < NOW()).
CREATE INDEX IF NOT EXISTS idx_idempotency_result_payloads_expiry
  ON idempotency_result_payloads(expires_at);
