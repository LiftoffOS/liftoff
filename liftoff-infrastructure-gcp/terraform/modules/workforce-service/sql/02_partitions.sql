-- workforce: pg_partman provisioning (plan 0i).
CREATE EXTENSION IF NOT EXISTS pg_partman;

SELECT partman.create_parent(
  p_parent_table      => 'public.workforce_audit_log',
  p_control           => 'created_at',
  p_type              => 'range',
  p_interval          => '1 month',
  p_premake           => 18,
  p_start_partition   => to_char(date_trunc('month', now()), 'YYYY-MM-DD')
);

UPDATE partman.part_config
SET
  retention                = '84 months', -- 7 years to match governance posture
  retention_keep_table     = false,
  infinite_time_partitions = true
WHERE parent_table = 'public.workforce_audit_log';

SELECT partman.run_maintenance(p_analyze => true);
