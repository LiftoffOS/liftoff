-- Migration: Rename ai_team to internal_agent terminology
-- Part of cross-repository terminology standardization

BEGIN;

-- 1. Rename cached_ai_teams table
ALTER TABLE cached_ai_teams RENAME TO cached_internal_agents;
ALTER TABLE cached_internal_agents RENAME COLUMN ai_team_id TO internal_agent_id;

-- 2. Rename ai_team_agent_mapping table
ALTER TABLE ai_team_agent_mapping RENAME TO internal_agent_runtime_mapping;
ALTER TABLE internal_agent_runtime_mapping RENAME COLUMN ai_team_id TO internal_agent_id;

-- 3. Rename workflow_tasks column
ALTER TABLE workflow_tasks RENAME COLUMN ai_team_id TO internal_agent_id;

-- 4. Rename audit_logs column
ALTER TABLE audit_logs RENAME COLUMN ai_team_id TO internal_agent_id;

-- 5. Update indexes for cached_internal_agents
ALTER INDEX IF EXISTS cached_ai_teams_tenant_idx RENAME TO cached_internal_agents_tenant_idx;
ALTER INDEX IF EXISTS idx_cached_ai_teams_tenant RENAME TO idx_cached_internal_agents_tenant;
ALTER INDEX IF EXISTS idx_cached_ai_teams_status RENAME TO idx_cached_internal_agents_status;

-- 6. Update indexes for workflow_tasks
ALTER INDEX IF EXISTS idx_workflow_tasks_ai_team RENAME TO idx_workflow_tasks_internal_agent;

-- 7. Update indexes for audit_logs
ALTER INDEX IF EXISTS idx_audit_logs_ai_team RENAME TO idx_audit_logs_internal_agent;

-- 8. Update internal_agent_runtime_mapping indexes (was ai_team_agent_mapping)
ALTER INDEX IF EXISTS idx_ai_team_agent_mapping_tenant RENAME TO idx_internal_agent_runtime_mapping_tenant;
ALTER INDEX IF EXISTS idx_ai_team_agent_mapping_ai_team RENAME TO idx_internal_agent_runtime_mapping_internal_agent;

COMMIT;
