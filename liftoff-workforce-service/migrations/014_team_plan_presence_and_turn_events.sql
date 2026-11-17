-- Migration 014: presence and turn events for the CAIO team-plan chat.
--
-- Brings /teams/plan to parity with agent chat on multiplayer. Mirrors
-- platform-backend migrations 306 (agent_chat_presence) and 309
-- (agent_chat_turn_events); the tables live here rather than there because
-- both answers depend on state in this database — the newest message comes
-- from team_plan_messages, and the turn itself runs in this service.
--
-- Delivery is polling, not a live connection. This service runs on Cloud Run
-- with min_instances=0 and no session affinity, so a long-lived socket per
-- viewer is not viable: it would be killed at the request cap, hold a
-- concurrency slot for its whole life, and land on an arbitrary instance with
-- no way to address it. Presence is therefore a heartbeat table read through a
-- staleness window, and a turn is a written log read back by cursor.
--
-- Writing the turn down rather than tee-ing a socket buys the thing a socket
-- cannot: replay. Somebody who joins halfway through a two-minute turn sees
-- what they missed, and so does anybody who reloads.

BEGIN;

-- Needed for the composite FK below: it must reference a unique key that
-- carries tenant_id, so presence rows cannot be pointed at another tenant's
-- thread even if tenant_id were wrong.
ALTER TABLE team_plan_threads
  ADD CONSTRAINT team_plan_threads_id_tenant_key UNIQUE (id, tenant_id);

-- ── Presence ─────────────────────────────────────────────────────────────
--
-- One row per (thread, account), rewritten every few seconds by whoever is
-- looking. Reads filter on a staleness window rather than trusting a "left"
-- signal, so a browser that dies without saying goodbye decays out on its own.
--
-- fillfactor leaves room in each page so the last_seen_at rewrite stays a HOT
-- update: the primary key never changes, so no index entry is rewritten and
-- the row does not have to migrate to another page.

CREATE TABLE team_plan_presence (
  thread_id    UUID NOT NULL,
  account_id   UUID NOT NULL,
  tenant_id    UUID NOT NULL,
  -- 'typing' decays to 'viewing' on read after a few seconds, so a client that
  -- dies mid-compose does not appear to type forever.
  state        TEXT NOT NULL CHECK (state IN ('viewing', 'typing')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, account_id),
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES team_plan_threads (id, tenant_id) ON DELETE CASCADE
) WITH (fillfactor = 70);

-- The only read: everyone on a thread seen recently. The primary key already
-- leads with thread_id, so this covers the staleness filter on top of it.
CREATE INDEX idx_tpp_thread_seen ON team_plan_presence (thread_id, last_seen_at DESC);

-- ── Turn events ──────────────────────────────────────────────────────────
--
-- `seq` is assigned by the producer, not a sequence object: within a turn there
-- is exactly one producer (runCAIOChatTurn), so an in-process counter is
-- gap-free and totally ordered. A Postgres sequence would leave gaps on
-- rollback, and a consumer cannot tell a gap from a lost event.
--
-- No FK to team_plan_threads: rows are written mid-turn on a hot path and
-- pruned opportunistically, and the tenant policy below is what actually
-- guards them. Same shape as platform-backend's agent_chat_turn_events.

CREATE TABLE team_plan_turn_events (
  turn_id    UUID NOT NULL,
  seq        INTEGER NOT NULL,
  tenant_id  UUID NOT NULL,
  thread_id  UUID NOT NULL,
  -- 'text' carries a coalesced chunk of assistant output; the rest mirror the
  -- SSE event vocabulary the sender already receives.
  kind       TEXT NOT NULL,
  payload    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (turn_id, seq)
);

-- The read "everything on this turn after seq N" is already served by the
-- primary key. This index serves the other question — "is a turn live on this
-- thread right now" — which the presence poll asks every few seconds.
CREATE INDEX idx_tpte_thread_recent
  ON team_plan_turn_events (thread_id, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Same style as migration 012: workforce_app runs with BYPASSRLS=false and
-- withTenantContext() sets the GUC. WITH CHECK is explicit here because both
-- tables take writes on the request path.

ALTER TABLE team_plan_presence ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_plan_presence_tenant_isolation ON team_plan_presence
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE team_plan_turn_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_plan_turn_events_tenant_isolation ON team_plan_turn_events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON team_plan_presence TO workforce_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON team_plan_turn_events TO workforce_app;

COMMIT;
