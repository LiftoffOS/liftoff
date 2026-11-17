-- migrations/034_restore_drills_gcp.sql
-- Add GCP Cloud Run Job fields for DR drill orchestration

ALTER TABLE restore_drills
  ADD COLUMN IF NOT EXISTS cloud_run_job_name TEXT,
  ADD COLUMN IF NOT EXISTS run_execution_id TEXT,
  ADD COLUMN IF NOT EXISTS cloud_sql_operation_id TEXT,
  ADD COLUMN IF NOT EXISTS source_instance TEXT,
  ADD COLUMN IF NOT EXISTS target_instance TEXT,
  ADD COLUMN IF NOT EXISTS pitr_timestamp TIMESTAMPTZ;

CREATE INDEX idx_restore_drills_execution ON restore_drills(run_execution_id)
  WHERE run_execution_id IS NOT NULL;

CREATE INDEX idx_restore_drills_scheduled ON restore_drills(started_at)
  WHERE status = 'scheduled';
