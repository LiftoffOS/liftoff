-- Migration 003: thread_id and invocation_id on actions table.
--
-- thread_id enables per-conversation cost attribution for interactive
-- chat workloads. invocation_id links each governance action back to
-- the tenant-runtime invocation that triggered it.
--
-- Both are nullable (autonomous/workflow runs have no thread_id;
-- pre-migration rows have neither). The partitioned parent propagates
-- to all monthly child partitions automatically in Postgres 12+.

ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS thread_id     TEXT,
  ADD COLUMN IF NOT EXISTS invocation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_actions_thread
  ON actions (tenant_id, thread_id)
  WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_actions_invocation
  ON actions (invocation_id)
  WHERE invocation_id IS NOT NULL;
