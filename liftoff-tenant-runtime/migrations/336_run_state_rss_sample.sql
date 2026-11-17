-- A memory datapoint on the run heartbeat (C5).
--
-- We already have the run-level ledger: `agent_run_states` heartbeats on every
-- appendItem, and the stalled-run reconciler completes the orphans as
-- failure_class='stalled'. What that ledger cannot tell an operator is WHY a
-- run stopped heartbeating. Cloud Run reports the instance death; it does not
-- say whether the run was climbing toward it.
--
-- One number, sampled on the heartbeat we already write, is enough to separate
-- "the process was killed for memory" from "the run hung": a stall whose last
-- heartbeats show RSS climbing hard is OOM-shaped, and one that stalls flat is
-- not. Nullable and additive — rows written before this migration, and any
-- write where the sample is unavailable, simply carry NULL.

BEGIN;

ALTER TABLE agent_run_states
  ADD COLUMN IF NOT EXISTS last_rss_bytes BIGINT;

COMMENT ON COLUMN agent_run_states.last_rss_bytes IS
  'Resident set size of the process at the most recent heartbeat (C5). Read by the stalled-run reconciler to classify OOM-shaped stalls. NULL when unsampled.';

COMMIT;
