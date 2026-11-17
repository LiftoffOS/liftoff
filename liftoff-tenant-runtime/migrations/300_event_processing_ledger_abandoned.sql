-- §4.8: allow an 'abandoned' status on event_processing_ledger so the idempotency
-- reconciler can mark stuck at_most_once side-effect rows — a claimed side effect
-- whose run crashed before resolve/fail, outcome unknown, never auto-re-fired — as
-- a terminal, operator-visible state distinct from 'failed' (which a retry re-runs).
--
-- Renumber on merge if 300 is taken upstream (many parallel branches).

ALTER TABLE event_processing_ledger
  DROP CONSTRAINT IF EXISTS event_processing_ledger_status_check;

ALTER TABLE event_processing_ledger
  ADD CONSTRAINT event_processing_ledger_status_check
  CHECK (status IN ('processing', 'completed', 'failed', 'abandoned'));
