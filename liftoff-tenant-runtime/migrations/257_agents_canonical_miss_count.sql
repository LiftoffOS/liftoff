-- N-consecutive-misses gate for the reconciler's orphan-delete path.
--
-- Previously the reconciler did `if (!canonicalById.has(internal_agent_id))
-- deleteJob` on a single listCanonicalAgents read. One transient bad read
-- from platform-backend (network blip, partial JSON, RLS misconfig, momentary
-- empty result) was enough to nuke a healthy agent's Cloud Scheduler job.
-- That single read became destructive.
--
-- Now: each tick increments `canonical_miss_count` when the agent is absent
-- from canonical and resets it to 0 when present. Orphan-delete fires only
-- after `canonical_miss_count >= 3` (≈15 minutes of consecutive misses at
-- the 5-min reconciler cadence). Three misses across separate HTTP calls
-- to PB makes a transient-bad-read false positive vanishingly unlikely.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS canonical_miss_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN agents.canonical_miss_count IS
  'Count of consecutive reconciler ticks where this agent was absent from platform-backend canonical list. Incremented when missing, reset to 0 when present. Orphan-delete only fires at >=3.';
