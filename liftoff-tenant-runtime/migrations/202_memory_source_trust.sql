-- migrations/127_memory_source_trust.sql

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS source_trust REAL NOT NULL DEFAULT 0.5
    CHECK (source_trust >= 0 AND source_trust <= 1);

CREATE INDEX IF NOT EXISTS idx_memories_source_trust
  ON memories(tenant_id, source_trust DESC)
  WHERE superseded_by IS NULL;

-- Backfill from provenance graph. Index-friendly: uses the
-- (tenant_id, node_type, ref_id) unique index on provenance_nodes (per
-- migration 117) so the JOIN is an index seek per memory, not a scan.
UPDATE memories m
SET source_trust = CASE pn_src.node_type
  WHEN 'chat_feedback'   THEN 1.00
  WHEN 'hitl_event'      THEN 0.90
  WHEN 'agent_action'    THEN 0.60
  WHEN 'system_event'    THEN 0.50
  WHEN 'connector_event' THEN 0.40
  ELSE 0.50
END
FROM provenance_nodes pn_mem
JOIN provenance_edges pe ON pe.to_node_id = pn_mem.id AND pe.edge_type = 'produced'
JOIN provenance_nodes pn_src ON pn_src.id = pe.from_node_id
WHERE pn_mem.tenant_id = m.tenant_id
  AND pn_mem.node_type = 'memory'
  AND pn_mem.ref_id = m.id::text
  AND pn_src.tenant_id = m.tenant_id;
