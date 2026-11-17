-- sandbox_usage_log partition maintenance: permanent crash fix + pre-created months.
--
-- Migration 083 created monthly partitions only through y2026m06 with NO DEFAULT
-- partition, and there is no ongoing maintenance. Past the last partition every
-- sandbox usage insert (recordUsage → sandbox_usage_log) whose timestamp has no
-- matching partition raises `no partition of relation "sandbox_usage_log" found
-- for row`, which THROWS in the executor path.
--
-- (1) DEFAULT partition = the permanent crash fix: any timestamp with no dedicated
--     partition lands here instead of throwing. It inherits the parent RLS policy
--     (RLS is enabled on the partitioned parent in migration 083).
-- (2) Pre-create dedicated monthly partitions (current + 11 months) for query
--     performance. CREATE ... PARTITION OF against a table that already has a
--     DEFAULT partition triggers a scan of the default for conflicting rows; that
--     is fine at this table's volume. `IF NOT EXISTS` is idempotent over any
--     monthly partition already created by hand.

CREATE TABLE IF NOT EXISTS sandbox_usage_log_default PARTITION OF sandbox_usage_log DEFAULT;

DO $$
DECLARE m date := date_trunc('month', now())::date;
BEGIN
  FOR i IN 0..11 LOOP  -- current + 11 months ahead
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS sandbox_usage_log_y%sm%s PARTITION OF sandbox_usage_log FOR VALUES FROM (%L) TO (%L)',
      to_char(m + (i||' month')::interval,'YYYY'), to_char(m + (i||' month')::interval,'MM'),
      (m + (i||' month')::interval)::date, (m + ((i+1)||' month')::interval)::date);
  END LOOP;
END $$;
