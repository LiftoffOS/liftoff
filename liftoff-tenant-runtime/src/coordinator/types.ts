// Coordinator Types
// Per Section 6: Workflow graph structure

import type { AgentRunItem } from '../agent-execution/run-state/types';

// Per Section 6: Each workflow contains
export interface Workflow {
  id: string;
  tenantId: string;
  agentId: string;

  // Per Section 6: Workflow components
  objective: string;
  status: WorkflowStatus;
  compensationState: CompensationState | null;
  finalOutcome: WorkflowOutcome | null;

  createdAt: Date;
  updatedAt: Date;
}

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'compensating'
  | 'compensated';

export interface CompensationState {
  reason: string;
  compensatedTasks: string[];
  pendingCompensations: string[];
}

export interface WorkflowOutcome {
  success: boolean;
  result: any;
  error?: string;
}

// Per Section 7: Required tables
export interface WorkflowTask {
  id: string;
  workflowId: string;
  agentId: string;
  status: TaskStatus;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export type TaskStatus =
  | 'pending'
  | 'leased'
  | 'running'
  | 'waiting'      // non-terminal: a self-woken child parked on a wake; fan-in counts it as still-pending
  | 'completed'
  | 'failed'
  // NON-terminal: waiting on dependencies. Set on every child that declares a
  // `dependsOn`, and cleared by the advance path once its upstream completes.
  // This is the ONLY meaning of `blocked`; the per-task failure limit uses
  // `abandoned` below, because a value already in use cannot take a second
  // meaning without silently breaking every query written against the first.
  | 'blocked'
  // Terminal-until-a-human-looks. Distinct from 'failed', which the dispatcher
  // may retry — an abandoned task has failed its way out of retries and stays
  // visible with its failure count while the rest of the workflow moves.
  | 'abandoned'
  | 'compensated';

export interface WorkflowTaskDependency {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
}

export interface WorkflowTaskOutput {
  id: string;
  taskId: string;
  output: any;
  createdAt: Date;
}

export interface WorkflowHandoff {
  id: string;
  workflowId: string;
  fromAgentId: string;
  toAgentId: string;
  taskId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: Date;
}

export interface WorkflowEscalation {
  id: string;
  workflowId: string;
  taskId: string;
  reason: string;
  status: 'pending' | 'resolved';
  resolvedAt: Date | null;
  resolution: any;
  createdAt: Date;
}

export interface WorkflowLease {
  id: string;
  taskId: string;
  workerId: string;
  expiresAt: Date;
  createdAt: Date;
}

// Per Section 7: ToolCall represents a pending external action
export interface ToolCall {
  id: string;
  connector: string;
  entityType: string;
  actionType: string;
  payload: any;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: any;
  error?: string;
}

export interface WorkflowCheckpoint {
  id: string;
  workflowId: string;
  taskId: string;
  state: any;
  // Per Section 7: Idempotency key for checkpoint resume
  idempotencyKey: string;
  // Per Section 7: Pending tool calls to resume on recovery
  pendingToolCalls: ToolCall[];
  createdAt: Date;

  // GAP-013 FIX: Missing checkpoint contract fields
  // Per Section 7: Workflow phase for state machine tracking
  phase: WorkflowPhase;
  // Per Section 7: Dependency satisfaction status for each dependency
  dependencySatisfaction: DependencySatisfaction[];
  // Per Section 7: Next allowed state transitions
  nextAllowedTransitions: WorkflowPhase[];
  // Sequence number for ordering checkpoints
  sequenceNumber: number;
}

// GAP-013 FIX: Workflow phase enum
export type WorkflowPhase =
  | 'initializing'
  | 'planning'
  | 'executing'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'compensating'
  | 'completed'
  | 'failed';

// GAP-013 FIX: Dependency satisfaction tracking
export interface DependencySatisfaction {
  dependencyId: string;
  dependencyType: 'task' | 'external' | 'approval';
  satisfied: boolean;
  satisfiedAt?: Date;
  value?: any;
}

// Valid phase transitions for state machine
export const VALID_PHASE_TRANSITIONS: Record<WorkflowPhase, WorkflowPhase[]> = {
  initializing: ['planning', 'failed'],
  planning: ['executing', 'awaiting_input', 'failed'],
  executing: ['completed', 'failed', 'awaiting_approval', 'compensating'],
  awaiting_input: ['executing', 'failed'],
  awaiting_approval: ['executing', 'compensating', 'failed'],
  compensating: ['failed', 'completed'],
  completed: [],
  failed: [],
};

export interface StartWorkflowInput {
  tenantId: string;
  agentId: string;
  objective: string;
  parentWorkflowId?: string;  // For child workflows
  parentTaskId?: string;       // Task that spawned this workflow
}

// Per Section 6: Child task/sub-workflow support

export interface ChildTask {
  id: string;
  parentTaskId: string;
  workflowId: string;
  taskType: 'subtask' | 'subworkflow';
  objective: string;
  status: TaskStatus;
  result: unknown;
  error: string | null;
  /** Consecutive non-success attempts. Reset by a success. */
  consecutiveFailures: number;
  /** Set when the task was blocked for repeated failure rather than retried
   *  again. Terminal until a human looks at it. */
  blockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  executorAgentId: string | null;
}

export interface HandoffContext {
  collapseHistory?: {
    enabled: boolean;
    wrapperTag?: string;
    maxItems?: number;
  };
  includeLastNMessages?: number;
  filter?: (items: AgentRunItem[]) => AgentRunItem[];
}

// Per Section 6: SpawnChildTaskInput includes agent/tenant for ownership verification
export interface SpawnChildTaskInput {
  parentTaskId: string;
  workflowId: string;
  objective: string;
  inputData?: Record<string, unknown>;
  // Per Section 6: Agent restrictions on workflow graph mutation
  // These fields are used to verify the requesting agent owns the workflow
  agentId?: string;
  tenantId?: string;
  parentInvocationId?: string;
  handoffContext?: HandoffContext;
  executorAgentId?: string;
  /** Content trust of the spawning (parent) run, stamped server-side into the
   *  child's persisted inputData (`_originTrust`) so the child inherits the taint
   *  when it later executes. Absent → trusted. */
  originTrust?: 'trusted' | 'untrusted_inbound';
}

export interface SpawnSubWorkflowInput {
  parentTaskId: string;
  parentWorkflowId: string;
  tenantId: string;
  agentId: string;
  objective: string;
  inputData?: Record<string, unknown>;
  waitForCompletion?: boolean; // If true, parent task waits
}

export interface ChildTaskResult {
  childTaskId: string;
  success: boolean;
  result: unknown;
  error: string | null;
}

export interface SubWorkflowResult {
  subWorkflowId: string;
  success: boolean;
  outcome: WorkflowOutcome | null;
}

// Workflow hierarchy tracking
export interface WorkflowHierarchy {
  workflowId: string;
  parentWorkflowId: string | null;
  depth: number;  // 0 = root, 1 = first level child, etc.
  rootWorkflowId: string;
}

// Phase 2: DAG executor types
export interface TaskNode {
  /** Local ID within this graph; referenced by `dependsOn`. Not persisted as-is. */
  id: string;
  objective: string;
  dependsOn?: string[];
  inputData?: Record<string, unknown>;
  /**
   * Optional specialist agent ID for executing this task. When set, the
   * child_task is created with `executor_agent_id` populated so the dispatcher
   * routes it to that specialist instead of executing under the parent agent.
   * Same semantic surface as `delegate_to_agent` but async / DAG-aware.
   */
  executorAgentId?: string;
}

export interface ExecuteTaskGraphInput {
  parentTaskId: string;
  workflowId: string;
  /** Requesting agent — used for ownership verification (existing pattern). */
  agentId: string;
  tenantId: string;
  parentInvocationId?: string;
  tasks: TaskNode[];
  /** Total wall-clock cap across all levels. Default 30 minutes. */
  graphTimeoutMs?: number;
  hitlLevel?: number;
  /** Content trust of the spawning run, propagated to every child task's persisted
   *  inputData (`_originTrust`) so the graph inherits the taint. Absent → trusted. */
  originTrust?: 'trusted' | 'untrusted_inbound';
}

export interface TaskNodeResult {
  /** The local ID from the input. */
  id: string;
  childTaskId: string | null;  // null for skipped
  status: 'completed' | 'failed' | 'skipped';
  result: unknown;
  error: string | null;
}

export interface ExecuteTaskGraphResult {
  parentTaskId: string;
  totalTasks: number;
  completed: number;
  failed: number;
  skipped: number;
  results: TaskNodeResult[];
}

export class TaskGraphCycleError extends Error {
  constructor(unresolvedIds: string[]) {
    super(`Task graph has a cycle. Unresolved: ${unresolvedIds.join(', ')}`);
    this.name = 'TaskGraphCycleError';
  }
}

export class TaskGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskGraphValidationError';
  }
}
