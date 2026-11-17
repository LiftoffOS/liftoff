-- Bind web_sessions to chat threads + carry takeover state for user-initiated handoff.
-- web_sessions schema reference at migrations/212_web_sessions.sql.

ALTER TABLE web_sessions
  ADD COLUMN thread_id UUID NULL,
  ADD COLUMN takeover_state TEXT NOT NULL DEFAULT 'none'
    CHECK (takeover_state IN ('none', 'taken_over')),
  ADD COLUMN taken_over_at TIMESTAMPTZ NULL;

-- Partial index for "active session for thread" queries (dashboard panel).
CREATE INDEX idx_web_sessions_tenant_thread
  ON web_sessions (tenant_id, thread_id, created_at DESC)
  WHERE closed_at IS NULL AND thread_id IS NOT NULL;

-- Dedupe table for Anchor webhook envelopes. Anchor delivers at-least-once;
-- we accept the first envelope by id and silently drop duplicates.
CREATE TABLE anchor_webhook_events (
  id            TEXT PRIMARY KEY,            -- envelope id from Anchor; PK enforces dedupe
  event_type    TEXT NOT NULL,               -- 'intervention.requested', 'session.completed', etc.
  vendor_session_id TEXT NULL,               -- extracted from envelope.data.session_id; NULL for events without one
  payload       JSONB NOT NULL,              -- full envelope for audit / replay
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup for "find recorded intervention.requested by request_id" used by
-- anchor-intervention-bridge.forwardAnchorInterventionResponse.
CREATE INDEX idx_anchor_webhook_events_vendor_session
  ON anchor_webhook_events (vendor_session_id, received_at DESC)
  WHERE vendor_session_id IS NOT NULL;

CREATE INDEX idx_anchor_webhook_events_request_id
  ON anchor_webhook_events ((payload->'data'->>'requestId'))
  WHERE event_type = 'intervention.requested';
