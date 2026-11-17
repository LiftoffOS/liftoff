// Workflow Engine — shared type definitions

export interface WorkflowNodeCondition {
  field: string;
  operator: 'eq' | 'neq' | 'contains' | 'exists';
  value?: unknown;
}

export interface WorkflowNode {
  id: string;
  type: 'agent_task' | 'parallel_start' | 'parallel_join' | 'condition';
  agent_id?: string;
  objective_template: string;
  input_mapping?: Record<string, string>;
  output_key?: string;
  parallel_branches?: string[];
  condition_field?: string;
  max_retries?: number;
  timeout_ms?: number;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: WorkflowNodeCondition;
}

export interface WorkflowDefinitionBody {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  entry_node_id: string;
}

export interface WorkflowDefinitionRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  version: number;
  definition: WorkflowDefinitionBody;
  status: 'draft' | 'active' | 'archived';
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowRunRow {
  id: string;
  tenant_id: string;
  definition_id: string;
  definition_version: number;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  context: Record<string, unknown>;
  current_node_ids: string[];
  triggered_by: string;
  trigger_ref: string | null;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowStepExecutionRow {
  id: string;
  run_id: string;
  node_id: string;
  agent_id: string;
  task_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  attempt: number;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}
