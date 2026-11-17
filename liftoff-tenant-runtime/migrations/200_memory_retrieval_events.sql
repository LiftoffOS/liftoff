-- migrations/125_memory_retrieval_events.sql
--
-- HASH-partitioned by tenant_id to match codebase convention (see migration 086
-- for awaiting_input_emissions). Per-tenant queries (recompute, rollup) stay
-- within a single partition. Time-based cleanup is a tenant-bounded scan per
-- partition.
--
-- NOTE: PARTITION BY HASH cannot have a UNIQUE index that omits the partition
-- key. The unique constraint on invocation_id is therefore enforced as a
-- composite UNIQUE INDEX (tenant_id, invocation_id) — invocation_id alone is
-- still globally unique by construction (it's a UUID), but the index must
-- include tenant_id.

CREATE TABLE memory_retrieval_events (
  id            UUID         NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL,
  agent_id      UUID,
  invocation_id UUID,
  thread_id     UUID,
  retrieved_ids UUID[]       NOT NULL,
  cited_ids     UUID[]       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, tenant_id)
) PARTITION BY HASH (tenant_id);

CREATE TABLE memory_retrieval_events_p0 PARTITION OF memory_retrieval_events FOR VALUES WITH (MODULUS 8, REMAINDER 0);
CREATE TABLE memory_retrieval_events_p1 PARTITION OF memory_retrieval_events FOR VALUES WITH (MODULUS 8, REMAINDER 1);
CREATE TABLE memory_retrieval_events_p2 PARTITION OF memory_retrieval_events FOR VALUES WITH (MODULUS 8, REMAINDER 2);
CREATE TABLE memory_retrieval_events_p3 PARTITION OF memory_retrieval_events FOR VALUES WITH (MODULUS 8, REMAINDER 3);
CREATE TABLE memory_retrieval_events_p4 PARTITION OF memory_retrieval_events FOR VALUES WITH (MODULUS 8, REMAINDER 4);
CREATE TABLE memory_retrieval_events_p5 PARTITION OF memory_retrieval_events FOR VALUES WITH (MODULUS 8, REMAINDER 5);
CREATE TABLE memory_retrieval_events_p6 PARTITION OF memory_retrieval_events FOR VALUES WITH (MODULUS 8, REMAINDER 6);
CREATE TABLE memory_retrieval_events_p7 PARTITION OF memory_retrieval_events FOR VALUES WITH (MODULUS 8, REMAINDER 7);

-- Idempotency via composite UNIQUE (tenant_id, invocation_id) — partition-aware.
-- WHERE clause permits multiple rows where invocation_id IS NULL (rare; e.g. internal calls).
CREATE UNIQUE INDEX idx_mre_invocation
  ON memory_retrieval_events(tenant_id, invocation_id)
  WHERE invocation_id IS NOT NULL;

CREATE INDEX idx_mre_tenant_created ON memory_retrieval_events(tenant_id, created_at);
CREATE INDEX idx_mre_retrieved_gin ON memory_retrieval_events USING GIN (retrieved_ids);
