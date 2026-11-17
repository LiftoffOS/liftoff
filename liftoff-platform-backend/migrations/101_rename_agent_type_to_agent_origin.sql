-- Rename agent_type → agent_origin for consistency with TypeScript AgentOrigin type

-- Rename the column
ALTER TABLE person_agent_assignments RENAME COLUMN agent_type TO agent_origin;

-- Drop the old CHECK constraint and re-add with new column name
ALTER TABLE person_agent_assignments DROP CONSTRAINT IF EXISTS person_agent_assignments_agent_type_check;
ALTER TABLE person_agent_assignments ADD CONSTRAINT person_agent_assignments_agent_origin_check
  CHECK (agent_origin IN ('internal', 'external'));
