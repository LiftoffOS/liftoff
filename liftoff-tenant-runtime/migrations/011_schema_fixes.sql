-- Migration 011: Fix schema mismatches between code and database
-- Per Section 6, 7: Required columns for workflow coordination
-- CRITICAL: These columns are referenced in code but missing from schema

-- ============================================
-- Fix child_tasks table
-- Per Section 6: child_tasks needs objective, input_data, task_type
-- ============================================
ALTER TABLE child_tasks ADD COLUMN IF NOT EXISTS objective TEXT;
ALTER TABLE child_tasks ADD COLUMN IF NOT EXISTS input_data JSONB DEFAULT '{}';
ALTER TABLE child_tasks ADD COLUMN IF NOT EXISTS task_type VARCHAR(50) DEFAULT 'subtask';
ALTER TABLE child_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Remove idempotency_key requirement from child_tasks (not used in code)
-- and agent_id (not used in code)
ALTER TABLE child_tasks ALTER COLUMN idempotency_key DROP NOT NULL;

-- ============================================
-- Fix workflow_hierarchy table
-- Per Section 6: workflow_hierarchy needs workflow_id, root_workflow_id
-- Schema has child_workflow_id but code expects workflow_id
-- ============================================
-- Rename child_workflow_id to workflow_id for consistency with code
ALTER TABLE workflow_hierarchy RENAME COLUMN child_workflow_id TO workflow_id;

-- Add root_workflow_id column
ALTER TABLE workflow_hierarchy ADD COLUMN IF NOT EXISTS root_workflow_id UUID REFERENCES workflows(id);

-- Update index for renamed column
DROP INDEX IF EXISTS idx_workflow_hierarchy_child;
CREATE INDEX IF NOT EXISTS idx_workflow_hierarchy_workflow ON workflow_hierarchy(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_hierarchy_root ON workflow_hierarchy(root_workflow_id);

-- ============================================
-- Fix workflow_tasks table
-- Per Section 7: workflow_tasks needs child_results for aggregation
-- ============================================
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS child_results JSONB DEFAULT '[]';
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- ============================================
-- Fix workflow_checkpoints table
-- Per Section 7: Add missing checkpoint fields for full resume support
-- ============================================
ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS phase VARCHAR(50);
ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS dependency_satisfaction_state JSONB DEFAULT '{}';
ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS persisted_action_intents JSONB DEFAULT '[]';
ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS reconciliation_state JSONB DEFAULT '{}';
ALTER TABLE workflow_checkpoints ADD COLUMN IF NOT EXISTS next_allowed_transition VARCHAR(100);

-- ============================================
-- Fix cached_entitlements table
-- Per Section 4: Add missing columns used by event subscriber
-- ============================================
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS agent_execution_allowed BOOLEAN DEFAULT false;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS remaining_credits INTEGER DEFAULT 0;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS overage_allowed BOOLEAN DEFAULT false;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS max_active_agents INTEGER DEFAULT 5;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS max_active_workflows INTEGER DEFAULT 10;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS max_actions_per_minute INTEGER DEFAULT 60;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS max_reflection_runs_per_day INTEGER DEFAULT 10;

-- ============================================
-- Fix cached_deployments table
-- Per Section 4: Add missing columns used by event subscriber
-- ============================================
ALTER TABLE cached_deployments ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE cached_deployments ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE;

-- ============================================
-- Fix cached_model_configs table
-- Per Section 17: Add model_id and routing_policy columns
-- ============================================
ALTER TABLE cached_model_configs ADD COLUMN IF NOT EXISTS model_id VARCHAR(100);
ALTER TABLE cached_model_configs ADD COLUMN IF NOT EXISTS routing_policy JSONB DEFAULT '{}';

-- ============================================
-- Fix cached_prompt_bundles table
-- Per Section 17: Add name, approved_at columns
-- ============================================
ALTER TABLE cached_prompt_bundles ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE cached_prompt_bundles ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE cached_prompt_bundles ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE cached_prompt_bundles ADD COLUMN IF NOT EXISTS entity_version INTEGER DEFAULT 1;

-- ============================================
-- Fix cached_feature_flags table
-- Per Section 4: Add entity_version column
-- ============================================
ALTER TABLE cached_feature_flags ADD COLUMN IF NOT EXISTS entity_version INTEGER DEFAULT 1;

-- ============================================
-- Fix cached_migration_status table
-- Per Section 4: Rename columns to match code expectations
-- ============================================
ALTER TABLE cached_migration_status RENAME COLUMN migration_status TO status;
ALTER TABLE cached_migration_status DROP COLUMN IF EXISTS current_version;
ALTER TABLE cached_migration_status DROP COLUMN IF EXISTS target_version;
ALTER TABLE cached_migration_status DROP COLUMN IF EXISTS error_message;
