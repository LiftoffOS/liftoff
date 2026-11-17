-- Migration 440: a lock is not a heartbeat
--
-- `chat_turn_locks` has the identical shape and the identical constants as the
-- two platform-backend turn-lock tables (heartbeat 2 min, lease 20 min — a 10x
-- gap), and therefore the identical defect: liveness was measured by heartbeating
-- a row and then written into `expires_at`, where the act of writing destroys it.
-- A row heartbeated 5 seconds ago and a row abandoned 19 minutes ago are the same
-- row to every reader.
--
-- An instance that exits mid-turn (for example after losing every Postgres
-- socket at once while Cloud SQL is healthy) leaves its lock row behind. Until
-- the lease expires, every message to that thread is accepted and filed as an
-- interrupt addressed to a turn nothing is running. Nothing about that is
-- specific to one service: here, `src/interactive-chat/locks.ts` reclaims a row
-- only once its lease has expired and
-- `src/agent-execution/engine/workspace-reaper.ts` treats any unexpired row as a
-- live workspace and skips it, so team chat has the same failure mode.
--
-- `heartbeat_at` is the missing fact. Liveness is then READ from it inside a
-- narrow window (75 s), and the lease keeps its one real job: reclaiming a row
-- whose owner never came back.
--
-- ROLLOUT: this migration ships with the WRITER ONLY. Cloud Run serves two
-- revisions during a rollout, and an old revision's heartbeat updates only
-- `expires_at` — so its running turn's `heartbeat_at` would stay frozen at the
-- row's insert time, and a new revision applying the 75-second predicate would
-- classify that live turn as dead and take its workspace apart underneath it. The
-- readers land in a second deployment, once this query returns zero:
--
--   SELECT count(*) FROM chat_turn_locks
--    WHERE expires_at > NOW() AND heartbeat_at < NOW() - INTERVAL '75 seconds';
--
-- The ordering is cross-repo: platform-backend's matching migration follows the
-- same writer-first, readers-second sequence.
--
-- DEFAULT NOW() is for the rows that exist when this runs, not for the writer:
-- the acquire INSERT names the column explicitly from this deployment on.
--
-- `chat_turn_locks` carries no row-level security (it has never had a policy), so
-- there is no NO FORCE / FORCE pair here and there must not be one — the
-- rls-coverage ratchet classifies tables from migration TEXT, and wrapping a
-- table that has no policy would mark it protected and fail on a debt-list entry
-- that does not exist.

ALTER TABLE chat_turn_locks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON COLUMN chat_turn_locks.heartbeat_at IS
  'When the owning turn last proved it was still running. Liveness is read from this inside a 75s window; expires_at only reclaims a row whose owner never came back (INV-PB-018).';
