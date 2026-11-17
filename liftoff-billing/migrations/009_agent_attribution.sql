-- Add agent attribution columns to meter_events.
-- agent_id and action_id are populated by the ReportUsage RPC handler from
-- the proto. NULL for records written before these columns existed.
ALTER TABLE meter_events
  ADD COLUMN agent_id TEXT,
  ADD COLUMN action_id TEXT;

CREATE INDEX idx_meter_events_agent
  ON meter_events (tenant_id, agent_id, occurred_at)
  WHERE agent_id IS NOT NULL;
