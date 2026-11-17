// Action Ledger Types
// Per Section 7: Action persistence for crash recovery

export interface Action {
  id: string;
  tenantId: string;
  agentId: string;
  workflowId: string;
  taskId: string;
  idempotencyKey: string;

  // Action details
  connector: string;
  entityType: string;
  actionType: string;
  targetRef: string;

  // Per Section 11: Trace ID for distributed tracing
  traceId: string | null;

  // Per Section 11: Instruction version for audit
  instructionVersion: number | null;

  // Per Section 11: Undo support mode from conflict policy
  // Values: 'full', 'partial', 'none'
  undoSupportMode: UndoSupportMode | null;

  // Per Section 11: Conflict resolution mode used
  conflictResolutionMode: string | null;

  // Per Section 7: Action payload
  payload: any;

  // Per Section 7: Pre-action snapshot reference
  preActionSnapshot: any;

  // Per Section 7: External response
  externalResponse: any;

  // Outcome
  status: ActionStatus;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

// Per Section 11: Undo support modes
export type UndoSupportMode = 'full' | 'partial' | 'none';

export type ActionStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'compensated';

export interface ActionIntent {
  tenantId: string;
  agentId: string;
  workflowId: string;
  taskId: string;
  idempotencyKey: string;
  connector: string;
  entityType: string;
  actionType: string;
  targetRef: string;
  snapshot?: any;

  // Per Section 11: Trace ID for distributed tracing
  traceId?: string;

  // Per Section 11: Instruction version for audit
  instructionVersion?: number;

  // Per Section 11: Undo support mode from conflict policy
  undoSupportMode?: UndoSupportMode;

  // Per Section 11: Conflict resolution mode used
  conflictResolutionMode?: string;

  // Per Section 7: Action payload
  payload?: any;

  // Connector call cost from ExecuteResponse — 0 for most API connectors
  costUsd?: number;

  // Thread and invocation IDs for cost attribution.
  // thread_id is only set for interactive chat turns; invocation_id comes
  // from the preflight token claims.
  threadId?: string;
  invocationId?: string;
}

// Per Section 7: Compensation support
export interface CompensationAction {
  id: string;
  originalActionId: string;
  workflowId: string;
  taskId: string;
  compensationType: CompensationType;
  status: CompensationStatus;
  compensationData: any;
  error: string | null;
  createdAt: Date;
  executedAt: Date | null;
}

export type CompensationType =
  | 'reverse'     // Directly undo the action
  | 'restore'     // Restore from pre-action snapshot
  | 'semantic'    // Apply semantic inverse (e.g., delete created record)
  | 'manual';     // Requires human intervention

export type CompensationStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface CompensationPlan {
  workflowId: string;
  reason: string;
  actions: CompensationStep[];
  status: 'pending' | 'executing' | 'completed' | 'partial' | 'failed';
  createdAt: Date;
  completedAt: Date | null;
}

export interface CompensationStep {
  actionId: string;
  compensationType: CompensationType;
  order: number;  // Reverse order of execution
  status: CompensationStatus;
  compensationActionId?: string;
}

export interface CompensationResult {
  actionId: string;
  success: boolean;
  compensationType: CompensationType;
  error?: string;
}
