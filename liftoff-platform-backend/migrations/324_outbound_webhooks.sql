-- Telling a customer's own system what happened, without letting that call
-- anywhere near the work that produced it.
--
-- Inbound webhooks have existed for a while: a customer's system pokes us and a
-- team member reacts. The other direction has not. A customer who wants their
-- own tooling to know that a run finished, or that an approval is waiting, has
-- to poll for it.
--
-- The whole design is shaped by one rule: an outbound call must never be able
-- to slow down, block, or fail a run. So nothing here is called inline. A
-- lifecycle event writes ONE row and returns; a single worker drains the queue
-- out of band. A customer endpoint that hangs for thirty seconds costs a worker
-- pass, never a tool call.
--
-- Two tables because they answer different questions and have wildly different
-- row counts: the registration is configuration a person manages, the delivery
-- is a bounded, self-pruning queue.

-- ── Registrations ────────────────────────────────────────────────────────────

CREATE TABLE outbound_webhooks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Where to POST. Validated against the shared SSRF guard at write time AND
  -- again at delivery time — a hostname that resolved publicly when it was
  -- registered can be re-pointed at an internal address afterwards.
  url          TEXT NOT NULL,
  -- Signing secret, encrypted at rest with the same envelope the inbound event
  -- sources use. Never returned by any read endpoint.
  secret_enc   BYTEA NOT NULL,
  -- Which lifecycle events this endpoint wants. Empty means none, not all:
  -- defaulting to everything would make a mis-click a firehose.
  event_types  TEXT[] NOT NULL DEFAULT '{}',

  -- Off until somebody deliberately turns it on. Sending a customer's data to
  -- a third-party endpoint is a governance decision, not a configuration
  -- default, so registering one is not the same act as enabling it.
  enabled      BOOLEAN NOT NULL DEFAULT false,
  -- Set when the platform disabled it rather than a person: a run of failures,
  -- or a URL that stopped resolving publicly. Distinct from `enabled = false`
  -- by choice so "never turned on" and "turned itself off" are not the same
  -- state to a person looking at the row.
  disabled_reason TEXT,
  consecutive_failures INT NOT NULL DEFAULT 0,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_success_at TIMESTAMPTZ,

  -- One registration per endpoint per tenant. A duplicate is a mistake that
  -- doubles every delivery, and it is far easier to refuse than to notice.
  UNIQUE (tenant_id, url)
);

CREATE INDEX idx_outbound_webhooks_live
  ON outbound_webhooks (tenant_id)
  WHERE enabled = true;

ALTER TABLE outbound_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbound_webhooks
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE outbound_webhooks IS
  'Customer-owned endpoints that receive HMAC-signed lifecycle events. Disabled by default: enabling one is a governance decision. Never called inline with a run.';

-- ── The queue ────────────────────────────────────────────────────────────────

CREATE TABLE outbound_webhook_deliveries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  webhook_id   UUID NOT NULL REFERENCES outbound_webhooks(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  -- The event data, stored rather than rebuilt so every attempt sends the
  -- identical body. The signature over it still changes per attempt — it
  -- covers a fresh timestamp, or the receiver's own replay window would reject
  -- a retry — so what a customer deduplicates on is the delivery id below plus
  -- the unchanging body, not the signature.
  payload      JSONB NOT NULL,

  -- pending | delivered | failed | abandoned
  --   failed    = will be retried
  --   abandoned = out of attempts; terminal, and visible
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error   TEXT,
  -- Response status of the last attempt, for the person trying to work out
  -- whether it is their endpoint or ours.
  last_status_code INT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,

  CONSTRAINT outbound_delivery_status_valid
    CHECK (status IN ('pending', 'delivered', 'failed', 'abandoned'))
);

-- The worker's only query: due work, oldest first.
CREATE INDEX idx_outbound_deliveries_due
  ON outbound_webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- For the per-tenant queue cap, which is what keeps one broken endpoint from
-- becoming everybody's problem.
CREATE INDEX idx_outbound_deliveries_tenant_open
  ON outbound_webhook_deliveries (tenant_id)
  WHERE status IN ('pending', 'failed');

ALTER TABLE outbound_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbound_webhook_deliveries
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE outbound_webhook_deliveries IS
  'Bounded outbound queue. Enqueue is one INSERT so a lifecycle event never waits on a customer endpoint; a single worker drains it. Capped per tenant, so one dead endpoint cannot fill the table.';
