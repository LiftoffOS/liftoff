-- What inputs was this agent's workflow built from?
--
-- `workflow_steps_hash` already exists and hashes the OUTPUT — it detects the
-- steps being tampered with after review. Nothing records what the steps were
-- DERIVED from, so the platform cannot answer the one question that matters
-- after an edit: is this graph still the graph these instructions imply?
--
-- For example: an agent's responsibilities are edited to post into a different
-- Slack channel and saved, which triggers a redistill. If the distiller
-- regenerates `instructions_md` with the new channel but returns no
-- `workflowSteps`, `service.update` treats the absent `workflowSteps` as "leave
-- unchanged". The graph keeps its Slack step hardcoding the old channel, the
-- agent keeps posting to the wrong channel, and every diagnostic says the agent
-- is fine because each column on its own IS fine. Only the relationship between
-- them is broken, and nothing stored that relationship.
--
-- `distill_input_fingerprint` closes that: it is a hash of the inputs the
-- CURRENT workflow was distilled from. Recompute the hash from the agent's
-- inputs today, compare, and a mismatch means the graph predates the
-- instructions. That is a cheap fleet-wide sweep and it is not specific to
-- Slack channels — the channel is one symptom, not what is wrong.
--
-- Nullable with no backfill, deliberately. Every existing row is of unknown
-- provenance; inventing a fingerprint from today's inputs would assert that
-- every current graph is up to date, which is precisely the claim that was
-- false and the reason this column exists. NULL means "not known to be fresh",
-- the sweep reports it as unverifiable rather than clean, and each agent earns
-- a real value at its next distillation.

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS distill_input_fingerprint TEXT;

COMMENT ON COLUMN internal_agents.distill_input_fingerprint IS
  'SHA-256 over the normalized distill inputs (responsibilities + role + bound '
  'integration types) that produced the CURRENT workflow_steps. Compare against '
  'a freshly computed hash to detect a graph that has gone stale against its '
  'instructions. NULL means the provenance is unknown — not that it is fresh.';

-- Partial index: the sweep only ever asks about agents that HAVE a graph, and
-- an agent with no steps has nothing that can be stale.
CREATE INDEX IF NOT EXISTS idx_internal_agents_stale_graph_sweep
  ON internal_agents (tenant_id)
  WHERE workflow_steps IS NOT NULL AND distill_input_fingerprint IS NULL;
