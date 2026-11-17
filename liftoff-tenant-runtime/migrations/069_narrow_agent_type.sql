-- Phase 1c: Narrow agents.agent_type to canonical literals and update any
-- remaining legacy rows. Migration 067 widened the column from VARCHAR(1)
-- to VARCHAR(20); the subscriber normalizer (Phase 1a) ensured new writes
-- used canonical form. This migration walks any pre-existing legacy rows
-- and changes the column default from 'B' to 'agent'.

UPDATE agents SET agent_type = 'agent' WHERE agent_type IN ('A', 'B');
UPDATE agents SET agent_type = 'workflow' WHERE agent_type = 'C';

ALTER TABLE agents ALTER COLUMN agent_type SET DEFAULT 'agent';
