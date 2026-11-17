-- Migration 348: chat storage for Liftoff, the general platform assistant.
--
-- Liftoff answers whatever someone types into the dashboard composer without
-- addressing anyone in particular. That makes it a platform surface, not one of
-- the customer's AI teams, so it gets its own tables the way Liftoff Insights
-- does rather than a row in internal_agents: rows there are the customer's own
-- teams, and a system row would be unreachable through tenant-scoped agent chat
-- anyway.
--
-- The shape is the insights chat's, arrived at over migrations 074 (threads,
-- messages, rate-limit ledger), 078 (rolling summary), 118 (title generation)
-- and 332 (mid-run control), collapsed into one file because this surface
-- starts where that one ended up. Two differences, both deliberate:
--
--   - no visualization_blocks column on the messages table. Liftoff replies in
--     plain text; the charts and tables belong to the analytics surface that
--     has the data tools.
--   - an attachments column the insights messages table does not have. This
--     surface takes files and connector references alongside the typed
--     message, and the metadata is what lets a reloaded thread still show
--     them.
--   - RLS is written out per table below instead of being inherited from the
--     DO-loops in migrations 095 / 287 / 289. Those already ran, so they will
--     never see these tables, and a table created after them gets nothing.

-- ── Threads ────────────────────────────────────────────────────────────
--
-- rolling_summary: JSONB snapshot of older turns on long threads, injected into
-- the next turn's context budget so continuity survives without shipping the
-- whole history every time. Nullable and sparse: short threads never need one,
-- and the list query does not select it.
--
-- title_source: 'ai' | 'user' | NULL. NULL means placeholder or untouched. The
-- AI title UPDATE guards on `title_source IS DISTINCT FROM 'user'`, so a future
-- user-rename endpoint is already safe from AI overwrite.
CREATE TABLE liftoff_chat_threads (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  account_id         UUID NOT NULL,
  title              VARCHAR(500),
  title_generated_at TIMESTAMPTZ,
  title_source       TEXT CHECK (title_source IN ('ai', 'user')),
  rolling_summary    JSONB,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Admin/owner listing (all tenant threads)
CREATE INDEX idx_liftoff_threads_tenant ON liftoff_chat_threads(tenant_id, updated_at DESC)
  WHERE deleted_at IS NULL;
-- Member/viewer listing (own threads only)
CREATE INDEX idx_liftoff_threads_account ON liftoff_chat_threads(tenant_id, account_id, updated_at DESC)
  WHERE deleted_at IS NULL;
-- Supports the title sweeper that retries threads which missed every in-flight
-- retry, the same partial index the other three thread tables carry.
CREATE INDEX idx_lct_needs_title
  ON liftoff_chat_threads (created_at)
  WHERE title_source IS NULL AND deleted_at IS NULL;

-- ── Messages ───────────────────────────────────────────────────────────
--
-- No tenant_id, therefore no RLS: tenancy is inherited from the thread, which
-- the repository resolves and permission-checks before any message read or
-- write. Same decision as insights_chat_messages, and the repository
-- compensates the same way.
--
-- attachments: what the message carried, so reopening the thread still shows
-- the files and connector references it was sent with. METADATA ONLY, and the
-- omission is the point: an upload's extracted text is a one-turn model input,
-- not transcript, and eight of them at 4000 characters each would put a second
-- copy of every document the model already read into this table. Nullable and
-- sparse the way insights_chat_messages.visualization_blocks is, since most
-- messages carry nothing; the repository reads NULL back as an empty list.
CREATE TABLE liftoff_chat_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     UUID NOT NULL REFERENCES liftoff_chat_threads(id) ON DELETE CASCADE,
  role          VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
  content       TEXT NOT NULL,
  attachments   JSONB,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_liftoff_messages_thread ON liftoff_chat_messages(thread_id, created_at ASC);

-- ── Rate limiting ──────────────────────────────────────────────────────
--
-- Its own ledger, so Liftoff's limits are independent of every other chat
-- surface. Read through the shared limiter in src/common/chat-rate-limiter.ts,
-- which only accepts table names on its allow-list.
CREATE TABLE liftoff_rate_limit_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL,
  account_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_liftoff_rate_limit_tenant ON liftoff_rate_limit_events(tenant_id, created_at DESC);
CREATE INDEX idx_liftoff_rate_limit_account ON liftoff_rate_limit_events(account_id, created_at DESC);

-- ── The lock, which is also the in-flight registry ─────────────────────
--
-- PRIMARY KEY (tenant_id, thread_id) is the mutex: a second concurrent turn on
-- the same thread cannot insert. Acquired via INSERT ... ON CONFLICT DO
-- NOTHING, renewed by a jittered heartbeat, released by DELETE. expires_at lets
-- a turn whose container died be reclaimed instead of wedging the thread.
CREATE TABLE liftoff_turn_locks (
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

CREATE INDEX idx_liftoff_turn_locks_expires ON liftoff_turn_locks (expires_at);

-- ── Signals delivered into a live turn ─────────────────────────────────
--
-- 'user_message': something the person typed while the turn was running. The
--                  loop claims it at an iteration boundary and appends it, so
--                  the turn already under way answers it.
-- 'abort':        an explicit Stop. Claimed first and wins; the turn keeps
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
CREATE TABLE liftoff_turn_signals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id     UUID NOT NULL
                REFERENCES liftoff_turn_locks (turn_id) ON DELETE CASCADE,
  signal_kind VARCHAR(64) NOT NULL CHECK (signal_kind IN ('user_message', 'abort')),
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ
);

-- The loop's boundary poll: pending signals for one turn. The partial index
-- keeps it small: rows live for seconds under any realistic cadence and never
-- outlive their turn.
CREATE INDEX idx_liftoff_turn_signals_pending
  ON liftoff_turn_signals (turn_id, consumed_at)
  WHERE consumed_at IS NULL;

-- Supports the cascade: without it, deleting a lock row sequentially scans the
-- signals table looking for children.
CREATE INDEX idx_liftoff_turn_signals_turn
  ON liftoff_turn_signals (turn_id);

-- ── Row-level security ─────────────────────────────────────────────────
--
-- Written out rather than inherited: the DO-loops that enable RLS on every
-- tenant_id table (migrations 095, 287, 289) have already run and will not see
-- anything created here.

ALTER TABLE liftoff_chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE liftoff_chat_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON liftoff_chat_threads
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE liftoff_rate_limit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE liftoff_rate_limit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON liftoff_rate_limit_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE liftoff_turn_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE liftoff_turn_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON liftoff_turn_locks
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Signals resolve tenancy through the lock that owns the turn, which is how
-- both the insights chat (migration 332) and the Chief AI Officer chat
-- (workforce-service migration 014) isolate the same table. The cascade above
-- is unaffected: referential actions run as the table owner, so a released lock
-- always takes its signals with it.
ALTER TABLE liftoff_turn_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE liftoff_turn_signals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON liftoff_turn_signals
  USING (
    turn_id IN (
      SELECT turn_id FROM liftoff_turn_locks
      WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
    )
  )
  WITH CHECK (
    turn_id IN (
      SELECT turn_id FROM liftoff_turn_locks
      WHERE tenant_id = current_setting('app.current_tenant_id')::uuid
    )
  );
