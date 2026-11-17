-- billing: pg_partman provisioning (plan 0i).
-- Applied after schema migrations by the billing-migrate Cloud Run Job.
-- Creates +18 months of forward partitions for append-only audit / usage
-- tables. A daily Cloud Scheduler job re-runs this logic to catch gaps.

CREATE EXTENSION IF NOT EXISTS pg_partman;

-- billing_audit_log: 7-year retention (plan 1b), monthly partitions,
-- hash-chain column already on the table.
SELECT partman.create_parent(
  p_parent_table      => 'public.billing_audit_log',
  p_control           => 'created_at',
  p_type              => 'range',
  p_interval          => '1 month',
  p_premake           => 18,
  p_start_partition   => to_char(date_trunc('month', now()), 'YYYY-MM-DD')
);

UPDATE partman.part_config
SET
  retention              = '84 months',   -- 7 years
  retention_keep_table   = false,
  retention_keep_index   = false,
  infinite_time_partitions = true
WHERE parent_table = 'public.billing_audit_log';

-- meter_events: 90-day OLTP retention; full history in BigQuery via the
-- bigquery-sink module (plan 0m). Monthly partitions.
SELECT partman.create_parent(
  p_parent_table      => 'public.meter_events',
  p_control           => 'occurred_at',
  p_type              => 'range',
  p_interval          => '1 month',
  p_premake           => 18,
  p_start_partition   => to_char(date_trunc('month', now()), 'YYYY-MM-DD')
);

UPDATE partman.part_config
SET
  retention              = '3 months',
  retention_keep_table   = false,
  infinite_time_partitions = true
WHERE parent_table = 'public.meter_events';

-- Run maintenance immediately so the current partition set exists.
SELECT partman.run_maintenance(p_analyze => true);
