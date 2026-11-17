ALTER TABLE connectors ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_connectors_agent ON connectors(tenant_id, agent_id) WHERE agent_id IS NOT NULL;
