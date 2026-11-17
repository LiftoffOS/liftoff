-- Escalation dedup + recurrence tracking.
--
-- createEscalation previously inserted a fresh workflow_escalations row (plus
-- a workflows + workflow_tasks parent pair, an SSE, and a durable
-- notification) on EVERY call, with no dedup. A scheduled agent whose required
-- connector is disconnected fails every run and escalates every run, so it
-- can pile up thousands of near-identical pending escalations until a person
-- pauses it.
--
-- These two columns let createEscalation collapse repeat escalations of the
-- same still-open issue into a single row: when an open (status='pending')
-- escalation already exists for (tenant_id, agent_id, kind), bump
-- occurrence_count + last_occurred_at instead of inserting a new row. Existing
-- rows backfill to occurrence_count=1, last_occurred_at=created_at.

ALTER TABLE workflow_escalations
  ADD COLUMN IF NOT EXISTS occurrence_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_occurred_at timestamptz;

UPDATE workflow_escalations
   SET last_occurred_at = created_at
 WHERE last_occurred_at IS NULL;

-- Partial index supporting the dedup lookup: the one open escalation per agent.
CREATE INDEX IF NOT EXISTS workflow_escalations_open_by_agent_idx
  ON workflow_escalations (tenant_id, agent_id, kind)
  WHERE status = 'pending';
