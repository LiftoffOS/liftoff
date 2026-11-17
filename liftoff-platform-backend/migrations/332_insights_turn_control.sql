-- Migration 332: mid-run control for the insights chat (ADR-041).
--
-- The insights chat gains what agent chat already has: a person can stop a turn
-- in flight, and a message typed while the assistant is working is folded into
-- the running turn instead of starting a second one on the same thread.
--
-- Two tables, not three. Tenant-Runtime needs a separate in-flight registry
-- because it runs several kinds of run and has to ask "which run did you mean".
-- The insights chat runs exactly one kind, so the lock row IS the registry: a
-- row in insights_turn_locks means a turn is live on that thread, and its
-- turn_id is the address signals are written to.
--
-- Signals are addressed by turn_id, never by thread, so a signal that arrives
-- too late to be consumed cannot be picked up by the NEXT turn on the thread.
-- It does not linger either: turn_id is a foreign key onto the lock, so a
-- signal dies with the turn it was addressed to.

-- ── The lock, which is also the in-flight registry ─────────────────────
--
-- PRIMARY KEY (tenant_id, thread_id) is the mutex: a second concurrent turn on
-- the same thread cannot insert. Acquired via INSERT ... ON CONFLICT DO
-- NOTHING, renewed by a jittered heartbeat, released by DELETE. expires_at lets
-- a turn whose container died be reclaimed instead of wedging the thread.
CREATE TABLE insights_turn_locks (
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  thread_id   UUID NOT NULL,
  -- UNIQUE because it is the address signals are written to: it is what the
  -- foreign key below points at, and turn ids are minted per turn so the
  -- constraint costs nothing.
  turn_id     UUID NOT NULL UNIQUE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '20 minutes',
  PRIMARY KEY (tenant_id, thread_id)
);

CREATE INDEX idx_insights_turn_locks_expires ON insights_turn_locks (expires_at);

-- ── Signals delivered into a live turn ─────────────────────────────────
--
-- 'user_message' — something the person typed while the turn was running. The
--                  loop claims it at an iteration boundary and appends it, so
--                  the turn already under way answers it.
-- 'abort'        — an explicit Stop. Claimed first and wins; the turn keeps
--                  whatever it had written and ends as a success carrying a
--                  user_stopped marker, never as a failure.
--
-- The foreign key is the retention policy. A signal belongs to exactly one turn
-- and is meaningless once that turn is gone, so the row goes with it: when the
-- turn releases its lock, or when a later turn reclaims an expired lock left by
-- a container that died mid-turn, the cascade takes the signals with it. There
-- is no sweeper to forget to schedule and no way to accumulate orphans.
--
-- It also makes a race honest: a signal written a moment after the turn ended
-- fails with a foreign-key violation instead of landing in a row nobody will
-- ever read, and the caller treats that as "no turn is running".
--
-- No tenant_id column: tenancy is inherited from the lock that owns the turn,
-- the same shape insights_chat_messages uses to inherit it from its thread.
-- Unlike that table, this one still carries what a person typed, so it gets a
-- policy rather than sitting open on the default pool — see below.
CREATE TABLE insights_turn_signals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id     UUID NOT NULL
                REFERENCES insights_turn_locks (turn_id) ON DELETE CASCADE,
  signal_kind VARCHAR(64) NOT NULL CHECK (signal_kind IN ('user_message', 'abort')),
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ
);

-- The loop's boundary poll: pending signals for one turn. The partial index
-- keeps it small — rows live for seconds under any realistic cadence and never
-- outlive their turn.
CREATE INDEX idx_insights_turn_signals_pending
  ON insights_turn_signals (turn_id, consumed_at)
  WHERE consumed_at IS NULL;

-- Supports the cascade: without it, deleting a lock row sequentially scans the
-- signals table looking for children.
CREATE INDEX idx_insights_turn_signals_turn
  ON insights_turn_signals (turn_id);

ALTER TABLE insights_turn_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE insights_turn_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insights_turn_locks
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Signals resolve tenancy through the lock that owns the turn, which is exactly
-- how the Chief AI Officer chat isolates the same table (workforce-service
-- migration 014). Both surfaces therefore reach signals only inside a tenant
-- context, and the one design really is one design.
--
-- The cascade above is unaffected: referential actions run as the table owner,
-- so a released lock always takes its signals with it.
ALTER TABLE insights_turn_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE insights_turn_signals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insights_turn_signals
  USING (
    turn_id IN (
      SELECT turn_id FROM insights_turn_locks
      WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
    )
  )
  WITH CHECK (
    turn_id IN (
      SELECT turn_id FROM insights_turn_locks
      WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
    )
  );
