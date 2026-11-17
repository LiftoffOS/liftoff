-- Migration 561: a lock is not a heartbeat
--
-- Both platform chat surfaces measure whether a turn is alive by heartbeating a
-- lock row, and then write that liveness into `expires_at` — where the act of
-- writing destroys it. The heartbeat ran every 2 minutes against a 20-minute
-- lease, a 10x gap, so a row heartbeated 5 seconds ago and a row abandoned 19
-- minutes ago are the same row to every reader.
--
-- If every Postgres socket on an instance closes at once, an `error` event can
-- land on a checked-out client with no listener and the container exits. The
-- lock row for the turn in flight stays. For up to twenty minutes every message
-- to that thread is then accepted and written as an interrupt signal addressed
-- to a turn nothing is running: no reply, and a toast that blames the
-- connection.
--
-- `heartbeat_at` is the missing fact. Liveness is then READ from it inside a
-- narrow window (75 s) instead of inferred from an unexpired lease, and the
-- lease keeps its one real job: reclaiming a row whose owner never came back.
--
-- ROLLOUT: this migration ships with the WRITER ONLY. Cloud Run serves two
-- revisions during a rollout, and an old revision's heartbeat updates only
-- `expires_at` — so its running turn's `heartbeat_at` would stay frozen at the
-- row's insert time, and a new revision applying the 75-second predicate would
-- classify that live turn as dead and reclaim the thread underneath it — a
-- new failure, caused by the fix. The readers land in a second deployment, once
-- no legacy live lock remains. Two gates, both required: this revision serves
-- 100% of traffic with the previous one drained, AND this returns zero on the
-- environment being deployed to:
--
--   SELECT count(*) FROM liftoff_turn_locks
--    WHERE expires_at > NOW() AND heartbeat_at < NOW() - INTERVAL '75 seconds';
--   -- and the same for insights_turn_locks
--
-- A turn on either of these two surfaces is bounded by their routers'
-- MAX_STREAM_DURATION_MS, which is 10 minutes (agent-chat's 880 s belongs to the
-- runtime's own lock table, not these), and the lease is 20 minutes — so waiting
-- one full lease after this reaches 100% guarantees it. The query is the proof,
-- not the wait.
--
-- DEFAULT NOW() is for the rows that exist when this runs, not for the writer:
-- the acquire INSERT names the column explicitly from this deployment on.
--
-- Both tables are tenant-scoped and FORCE RLS; adding a column changes no
-- policy, and nothing here writes a row, so no NO FORCE / FORCE pair is needed.

ALTER TABLE liftoff_turn_locks  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE insights_turn_locks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON COLUMN liftoff_turn_locks.heartbeat_at IS
  'When the owning turn last proved it was still running. Liveness is read from this inside a 75s window; expires_at only reclaims a row whose owner never came back (INV-PB-018).';
COMMENT ON COLUMN insights_turn_locks.heartbeat_at IS
  'When the owning turn last proved it was still running. Liveness is read from this inside a 75s window; expires_at only reclaims a row whose owner never came back (INV-PB-018).';
