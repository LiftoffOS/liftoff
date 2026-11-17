-- Durable record of a reply we owe a messaging surface (C1).
--
-- ADR-041 made the INBOUND half durable: a Slack or Teams message is enqueued
-- onto a Cloud Tasks queue before the surface is acked, so the turn survives a
-- container going away mid-request. The OUTBOUND half had nothing. If the
-- worker ran the whole turn — burning the tokens, doing the work — and then the
-- post to Slack failed, the task 5xx'd and Cloud Tasks re-ran the ENTIRE turn,
-- re-invoking the tenant runtime from scratch. Worse, if the retries ran out,
-- the reply was simply gone: generated, paid for, never seen.
--
-- One row per turn-delivery (not per streaming frame). The reply text itself is
-- NOT copied here — it is already durable in agent_chat_messages, keyed by
-- turn_id — so this table records only the obligation and its state.
--
-- Honest at-least-once: a redelivery after a crash carries a visible marker
-- saying it is a recovered reply, because we genuinely cannot know whether the
-- first attempt landed. A silent duplicate would be worse than an honest one.

CREATE TABLE chat_delivery_obligations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  agent_id      UUID NOT NULL,
  thread_id     UUID NOT NULL,
  -- The turn whose assistant reply is owed. The reply is read back from
  -- agent_chat_messages via this key when a sweep redelivers.
  turn_id       UUID NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('slack', 'teams')),
  -- Where it goes, in the surface's own terms (Slack channel id, Teams
  -- conversation id). Free-form because the two surfaces disagree on shape.
  target_ref    TEXT NOT NULL,

  -- pending    — the worker is about to post, or is posting now.
  -- delivered  — the surface accepted it.
  -- failed     — a definitive rejection; a sweep may retry.
  -- abandoned  — out of attempts. Kept briefly for inspection, then pruned.
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'delivered', 'failed', 'abandoned')),
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at  TIMESTAMPTZ
);

-- One obligation per turn: the worker's idempotency short-circuit and the sweep
-- both key on this, so a re-run must find the existing row rather than add a
-- second.
CREATE UNIQUE INDEX idx_cdo_turn ON chat_delivery_obligations (turn_id);

-- The sweep's query: rows still owed, oldest first.
CREATE INDEX idx_cdo_outstanding
  ON chat_delivery_obligations (status, updated_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX idx_cdo_tenant ON chat_delivery_obligations (tenant_id);

ALTER TABLE chat_delivery_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_delivery_obligations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_delivery_obligations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
