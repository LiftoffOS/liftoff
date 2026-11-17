-- Retention + write-time classification for the two application DLQ tables.
--
-- Two tables record dead-lettered work, and neither had retention or a signal:
--
--   dlq_messages   the app gave up on an event (poison cap at delivery 8,
--                  schema-invalid, or retries exhausted). Terminal: nothing
--                  drains it. Rows accumulate with nothing reading them
--                  until someone triages them by hand.
--   failed_events  the drainer pulled a message off the Pub/Sub DLQ
--                  subscription and republished it to the live topic.
--
-- The second one is where the damage is. Without a replay bound on the
-- drainer, any event that fails persistently ping-pongs between the live
-- topic and the DLQ every ten minutes until the underlying bug is fixed, and
-- one event can be republished hundreds of times. The cap that stops that
-- lives in the drainer; this migration adds the
-- column it records the decision in and the indexes both sweeps need.
--
-- The retention rule for both tables is the same one the escalation sweep uses
-- (migration 354): delete what is finished, never delete what is unresolved.
-- A row nobody has dealt with is the queue's whole reason to exist, and
-- deleting it on a timer makes the queue look healthy while the work is lost.

-- Write-time classification. Two values, because they imply different actions:
--   transient  the failure looked retryable and the retries ran out. Replaying
--              it after the dependency recovers is the remediation.
--   permanent  a schema or contract defect. Replaying it without a code change
--              is pointless, so this needs a fix, not a retry.
-- NULL means "written before this column existed"; those rows all age out.
ALTER TABLE dlq_messages
  ADD COLUMN IF NOT EXISTS failure_class TEXT
    CHECK (failure_class IN ('transient', 'permanent'));

-- Retention sweep predicate: terminal rows, oldest first.
-- Partial, because pending rows are never deleted and so never scanned.
CREATE INDEX IF NOT EXISTS idx_dlq_messages_terminal_resolved_at
  ON dlq_messages (resolved_at)
  WHERE status IN ('resolved', 'discarded');

-- Backlog signal: pending rows, oldest first. Powers both the count and the
-- oldest-age reading the sweep reports, without touching the terminal rows.
CREATE INDEX IF NOT EXISTS idx_dlq_messages_pending_failed_at
  ON dlq_messages (failed_at)
  WHERE status IN ('pending', 'processing');

-- failed_events retention: a republished row is a forensic trail of a path
-- that already completed, so it ages out. A row that was NOT republished is
-- outstanding work (unparseable payload, or replay-capped) and is kept.
CREATE INDEX IF NOT EXISTS idx_failed_events_republished_drained_at
  ON failed_events (drained_at)
  WHERE republished;

CREATE INDEX IF NOT EXISTS idx_failed_events_unreplayed_drained_at
  ON failed_events (drained_at)
  WHERE NOT republished;

-- Replay-cap lookup in the drainer counts prior successful republishes of the
-- same event. failed_events_event_id (migration 216) covers original_event_id;
-- this narrows it to the republished rows the cap actually counts.
CREATE INDEX IF NOT EXISTS idx_failed_events_event_republished
  ON failed_events (original_event_id)
  WHERE republished AND original_event_id IS NOT NULL;
