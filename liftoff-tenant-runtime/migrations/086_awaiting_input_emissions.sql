-- awaiting_input_emissions (hash-partitioned by tenant_id)
-- Rate-limit tracking for WAITING_FOR_INPUT emissions.
-- Partition key is tenant_id (HASH, 8 partitions) so per-tenant rate-limit DELETE
-- stays within a single partition — addresses R4 BE-R4-006 global-scan concern.

CREATE TABLE IF NOT EXISTS awaiting_input_emissions (
  tenant_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  emitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY HASH (tenant_id);

-- Hash partitions (8 for bounded per-partition growth)
CREATE TABLE IF NOT EXISTS awaiting_input_emissions_p0 PARTITION OF awaiting_input_emissions
  FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE IF NOT EXISTS awaiting_input_emissions_p1 PARTITION OF awaiting_input_emissions
  FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE IF NOT EXISTS awaiting_input_emissions_p2 PARTITION OF awaiting_input_emissions
  FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE IF NOT EXISTS awaiting_input_emissions_p3 PARTITION OF awaiting_input_emissions
  FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE IF NOT EXISTS awaiting_input_emissions_p4 PARTITION OF awaiting_input_emissions
  FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE IF NOT EXISTS awaiting_input_emissions_p5 PARTITION OF awaiting_input_emissions
  FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE IF NOT EXISTS awaiting_input_emissions_p6 PARTITION OF awaiting_input_emissions
  FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE IF NOT EXISTS awaiting_input_emissions_p7 PARTITION OF awaiting_input_emissions
  FOR VALUES WITH (MODULUS 8, REMAINDER 7);

CREATE INDEX IF NOT EXISTS idx_awaiting_input_emissions_lookup
  ON awaiting_input_emissions (tenant_id, thread_id, emitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_awaiting_input_emissions_reaper
  ON awaiting_input_emissions (tenant_id, emitted_at);

COMMENT ON TABLE awaiting_input_emissions IS
  'WAITING_FOR_INPUT rate-limit trail. Hash-partitioned by tenant_id.';
