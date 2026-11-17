-- Cold-start metric — when the Cloud Run startup probe first returns 200.
ALTER TABLE sandbox_state
  ADD COLUMN IF NOT EXISTS ready_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_sandbox_state_cold_start ON sandbox_state(ready_at, created_at) WHERE ready_at IS NOT NULL;
