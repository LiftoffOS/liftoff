-- Repeating a stage changes nothing that can be applied (ADR-052 rule 5, clause 1).
--
-- A stage is the connector's own draft operation, and a draft is what the
-- vendor holds unsent: repeating the stage call prepares ANOTHER draft. The
-- protocol's promise is not that the vendor holds one draft — it cannot be,
-- on a vendor whose stage is a draft — but that repeating the stage leaves
-- exactly one batch a person could be asked about: the latest. The host keys
-- each batch on the canonical arguments the stage was called with, and a new
-- batch under the same binding with the same arguments supersedes every
-- earlier one still waiting for a decision. An approved batch is never
-- superseded — the person said yes to that one — and the vendor's earlier
-- draft stays where the vendor put it, applicable by nothing.

ALTER TABLE staged_write_batches
  ADD COLUMN IF NOT EXISTS stage_args_hash TEXT;

CREATE INDEX IF NOT EXISTS staged_write_batches_restage_idx
  ON staged_write_batches (tenant_id, agent_id, connector, stage_tool, stage_args_hash)
  WHERE status = 'staged';

COMMENT ON COLUMN staged_write_batches.stage_args_hash IS
  'sha256 over the canonical arguments the stage tool was called with. A later batch under the same tenant, agent, connector and stage tool with the same hash supersedes every earlier batch still in status staged, so repeating a stage leaves one applicable batch: the latest.';
