-- usage_records already exists from migration 012 with columns:
--   tenant_id (VARCHAR), meter_name, value, timestamp, agent_id, workflow_id, metadata
-- The operator dashboard reads from that table directly; no structural changes needed
-- other than tagging rows with a record_type for downstream filtering.

ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS record_type TEXT NOT NULL DEFAULT 'event';
