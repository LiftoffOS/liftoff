// Action ledger types — extracted from tenant-runtime src/action-ledger,
// shared between the current home (tenant-runtime) and governance-engine
// (Phase 3 extraction target).

export type ActionStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'compensated';

export type UndoSupportMode = 'full' | 'partial' | 'none';

/** Intent to perform an action — written before the side-effect. */
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
  snapshot?: unknown;

  traceId?: string;
  instructionVersion?: number;
  undoSupportMode?: UndoSupportMode;
  conflictResolutionMode?: string;
  payload?: unknown;
}

/** Recorded action — result of executing an intent. */
export interface Action {
  id: string;
  tenantId: string;
  agentId: string;
  workflowId: string;
  taskId: string;
  idempotencyKey: string;

  connector: string;
  entityType: string;
  actionType: string;
  targetRef: string;

  traceId: string | null;
  instructionVersion: number | null;
  undoSupportMode: UndoSupportMode | null;
  conflictResolutionMode: string | null;

  payload: unknown;
  preActionSnapshot: unknown;
  externalResponse: unknown;

  status: ActionStatus;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export type CompensationType =
  | 'reverse'
  | 'restore'
  | 'semantic'
  | 'manual';

export type CompensationStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface CompensationAction {
  id: string;
  originalActionId: string;
  workflowId: string;
  taskId: string;
  compensationType: CompensationType;
  status: CompensationStatus;
  compensationData: unknown;
  error: string | null;
  createdAt: Date;
  executedAt: Date | null;
}

export interface CompensationStep {
  actionId: string;
  compensationType: CompensationType;
  order: number;
  status: CompensationStatus;
  compensationActionId?: string;
}

export interface CompensationPlan {
  workflowId: string;
  reason: string;
  actions: CompensationStep[];
  status: 'pending' | 'executing' | 'completed' | 'partial' | 'failed';
  createdAt: Date;
  completedAt: Date | null;
}

export interface CompensationResult {
  actionId: string;
  success: boolean;
  compensationType: CompensationType;
  error?: string;
}
