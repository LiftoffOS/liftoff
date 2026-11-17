-- DEFAULT partitions for actions and usage_events.
--
-- Migration 001 pre-created 18 months by hand and nothing creates more. When
-- the list runs out Postgres raises 23514 on insert rather than inventing a
-- partition, and both writers here swallow that: the action ledger's caller
-- sits inside a Promise.allSettled that logs "ledger write failed (non-fatal)",
-- so the request succeeds and the rows are lost.
--
-- A DEFAULT partition turns that from silent loss into rows parked somewhere
-- recoverable. It is a net, not a mechanism: the scheduled partition job still
-- has to create each month ahead of time, because once the default holds a row
-- for month M, creating M's partition fails until those rows are moved out. In
-- normal operation nothing lands here, and anything that does is the signal
-- that maintenance has been broken for a long time.

BEGIN;

CREATE TABLE IF NOT EXISTS actions_default PARTITION OF actions DEFAULT;
CREATE TABLE IF NOT EXISTS usage_events_default PARTITION OF usage_events DEFAULT;

COMMIT;
