-- Person-to-Agent Assignments
-- Links company personnel (employees/contractors) to AI agents (internal/external)
-- A person can be assigned to multiple agents for review-queue workload handling
--
-- Uses soft-delete (SCD pattern) matching internal_agents and external_agents:
-- Unassigning sets deleted_at = NOW() instead of hard-deleting the row.
-- Historical records (feedback requests, audit logs, tasks) that reference
-- an assignment ID remain valid.
--
-- Note: agent_id is polymorphic (references either internal_agents or external_agents
-- depending on agent_type). No FK constraint is possible at the database level.
-- Referential integrity is enforced in the service layer.

CREATE TABLE IF NOT EXISTS person_agent_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL,
    agent_type VARCHAR(20) NOT NULL CHECK (agent_type IN ('internal', 'external')),
    created_by UUID REFERENCES accounts(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Partial unique index: only one active assignment per (person, agent) pair
-- Allows re-assignment after soft-delete (old row has deleted_at set)
CREATE UNIQUE INDEX idx_person_agent_assignments_active_unique
    ON person_agent_assignments (tenant_id, account_id, agent_id, agent_type)
    WHERE deleted_at IS NULL;

-- Query indexes (partial, only active assignments)
CREATE INDEX idx_person_agent_assignments_tenant
    ON person_agent_assignments (tenant_id)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_person_agent_assignments_tenant_account
    ON person_agent_assignments (tenant_id, account_id)
    WHERE deleted_at IS NULL;

CREATE INDEX idx_person_agent_assignments_agent
    ON person_agent_assignments (agent_id, agent_type)
    WHERE deleted_at IS NULL;

-- Trigger to auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_person_agent_assignments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_person_agent_assignments_updated_at
    BEFORE UPDATE ON person_agent_assignments
    FOR EACH ROW
    EXECUTE FUNCTION update_person_agent_assignments_updated_at();
