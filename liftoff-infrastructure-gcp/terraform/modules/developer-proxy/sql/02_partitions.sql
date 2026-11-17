-- developer_proxy: pg_partman provisioning (plan 0i).
-- developer_proxy_usage_log: 90-day OLTP retention; full history in BigQuery via
-- bigquery-sink module (plan 0m).
CREATE EXTENSION IF NOT EXISTS pg_partman;

SELECT partman.create_parent(
  p_parent_table      => 'public.developer_proxy_usage_log',
  p_control           => 'created_at',
  p_type              => 'range',
  p_interval          => '1 month',
  p_premake           => 18,
  p_start_partition   => to_char(date_trunc('month', now()), 'YYYY-MM-DD')
);

UPDATE partman.part_config
SET
  retention                = '3 months',
  retention_keep_table     = false,
  infinite_time_partitions = true
WHERE parent_table = 'public.developer_proxy_usage_log';

SELECT partman.run_maintenance(p_analyze => true);
