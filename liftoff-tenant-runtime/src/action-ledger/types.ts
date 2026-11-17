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

  /** Revision of `targetRef` this action applied to — a GitHub head sha, an
   *  HTTP etag, a vendor version token. Null when the payload named none, which
   *  is the common case. Separate from `targetRef` so entity identity stays
   *  stable across revisions (migration 373). */
  targetVersion: string | null;

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

  // Post-action snapshot captured after CREATE operations (becomes the "before"
  // baseline for any future agent update on the same record).
  postActionSnapshot?: unknown;

  // Snapshot lifecycle status: 'captured' | 'skipped_read_op' | 'skipped_create'
  // | 'unavailable_approved'
  snapshotStatus?: string;

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
  /** See Action.targetVersion. Optional so existing callers compile; the
   *  gateway supplies it from `deriveTarget`. */
  targetVersion?: string | null;
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

  // Snapshot lifecycle status
  snapshotStatus?: string;

  /** The run this action belongs to. Survives a pause and resume where the
   *  trace id does not; the duplicate lookup prefers it. */
  invocationId?: string;

  /** Identity of the act, `<operation>|<target path>` — see `actKeyFor`.
   *  Null when the payload names no target. */
  actKey?: string | null;
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
