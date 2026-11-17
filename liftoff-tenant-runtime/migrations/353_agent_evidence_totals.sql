-- Migration 353: keep the learning signal when the rows behind it are deleted.
--
-- ReflectionRepository.getEvidenceCounts reads, all-time and unbounded:
--
--   SELECT COUNT(*) FROM workflow_escalations
--    WHERE agent_id = $1 AND status = 'resolved'   AS human_corrections
--
-- The reflection engine reasons over that number: it is an agent's history of
-- having been corrected by a person. Retention deletes resolved escalations
-- once they are 30 days old, so without this table the first sweep would walk
-- an agent's correction count DOWN — not freeing storage, but rewriting what
-- the platform believes about how often that agent needed a human. An agent
-- corrected forty times last quarter would read as never corrected.
--
-- The fix is the ordinary one for this shape: aggregates outlive rows. The
-- counter is incremented at the moment of the event and is never derived from
-- the rows again, so deleting a row cannot move it.
--
-- Scope note: only the ALL-TIME count needs this. getRecentEvidenceCounts is
-- windowed to N days, and the retention window (30 days) is wider than every
-- window it is called with, so its rows are still present when it asks.
-- `escalations` (status='pending') also stays a live query: a pending row is
-- swept to resolved before it is ever eligible for deletion, so counting it
-- live can never be wrong.

CREATE TABLE agent_evidence_totals (
  tenant_id         UUID NOT NULL,
  agent_id          UUID NOT NULL,
  -- Escalations a person resolved. The number retention must not be able to
  -- move.
  human_corrections BIGINT NOT NULL DEFAULT 0,
  -- Every escalation ever raised for this agent, kept alongside because it is
  -- the denominator anyone reading a correction count will want next, and it
  -- costs one more column now versus another migration later.
  escalations_raised BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id)
) WITH (fillfactor = 70);

CREATE INDEX idx_aet_tenant ON agent_evidence_totals (tenant_id);

COMMENT ON COLUMN agent_evidence_totals.human_corrections IS
  'Escalations a person resolved through the review queue. Incremented by '
  'recordHumanCorrection on escalation resolution. Do not re-derive from '
  'workflow_escalations: retention deletes resolved rows.';

-- Backfill from the rows while they are all still here. This is the one moment
-- the counter can be derived; after this it is only ever incremented.
-- human_corrections starts at zero: a resolved escalation does not record
-- whether a person closed it through the review queue, so no query over
-- workflow_escalations can derive it.
INSERT INTO agent_evidence_totals (tenant_id, agent_id, human_corrections, escalations_raised)
SELECT tenant_id,
       agent_id,
       0,
       COUNT(*)
  FROM workflow_escalations
 WHERE agent_id IS NOT NULL
 GROUP BY tenant_id, agent_id
ON CONFLICT (agent_id) DO NOTHING;
