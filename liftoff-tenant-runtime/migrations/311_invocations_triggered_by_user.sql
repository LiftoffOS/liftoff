-- 311: persist the triggering human on the invocation row.
-- Identity: PB account id, or slack:<id>/teams:<id> for unmapped channel users.
-- NULL for cron/event/agent runs and human paths that carry no user id.
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS triggered_by_user_id TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_invocations_triggered_by_user
  ON invocations (tenant_id, triggered_by_user_id)
  WHERE triggered_by_user_id IS NOT NULL;
COMMENT ON COLUMN invocations.triggered_by_user_id IS
  'Triggering human: PB account id, or slack:<id>/teams:<id>. NULL when unknown or non-human.';
