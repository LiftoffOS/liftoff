-- migrations/014_model_catalog_and_partitions.sql
-- 1. Reviewed Codex model-catalog metadata: capability/presentation
--    fields (reasoning levels, context window, max output, tools, api) are
--    OPERATOR-REVIEWED DATA, not code constants. The /codex/v1/models route
--    and the CLI-generated local catalog serve exactly what this column
--    holds; models without metadata are served as minimal {id} entries and
--    the CLI emits no invented capability values. Populated during
--    contract-fixture review alongside the pricing seed.
-- 2. Partition horizon: developer_proxy_usage_log partitions ended
--    at 2027-01; extend monthly through 2027 so provisioning continues
--    beyond the current horizon.

BEGIN;

-- 1. Catalog metadata: { "<model>": { ...codex catalog fields... } }
ALTER TABLE developer_proxy_vendor_config
  ADD COLUMN model_catalog JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN developer_proxy_vendor_config.model_catalog IS
  'Reviewed Codex catalog metadata per model. Served verbatim by /codex/v1/models and copied into the CLI-generated model_catalog_json; no capability values are invented in code.';

-- 2. 2027 monthly partitions
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m01 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m02 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m03 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m04 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m05 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m06 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m07 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m08 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m09 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m10 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m11 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-11-01') TO ('2027-12-01');
CREATE TABLE IF NOT EXISTS developer_proxy_usage_log_y2027_m12 PARTITION OF developer_proxy_usage_log
  FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');

COMMIT;
