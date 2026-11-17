CREATE TABLE provenance_nodes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  node_type     TEXT        NOT NULL,
  ref_id        TEXT        NOT NULL,
  connector_id  UUID,
  agent_id      UUID,
  confidence    REAL        CHECK (confidence BETWEEN 0 AND 1),
  metadata      JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ON provenance_nodes (tenant_id, node_type, ref_id);
CREATE INDEX ON provenance_nodes (tenant_id, connector_id) WHERE connector_id IS NOT NULL;
CREATE INDEX ON provenance_nodes (tenant_id, agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX ON provenance_nodes (tenant_id, node_type);

CREATE TABLE provenance_edges (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_node_id  UUID        NOT NULL REFERENCES provenance_nodes(id) ON DELETE CASCADE,
  to_node_id    UUID        NOT NULL REFERENCES provenance_nodes(id) ON DELETE CASCADE,
  edge_type     TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON provenance_edges (tenant_id, from_node_id);
CREATE INDEX ON provenance_edges (tenant_id, to_node_id);
CREATE UNIQUE INDEX ON provenance_edges (from_node_id, to_node_id, edge_type);
