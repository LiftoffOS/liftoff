// Correction Protocol Types for Tenant Runtime
// Per implementation plan: Execution plane types for correction operations

// Correction event from control plane
export interface CorrectionRequestedEvent {
  correctionRequestId: string;
  tenantId: string;
  originalAuditLogId: string;
  correctionToolName: string;
  correctionType: CorrectionType;
  requiresPreviousState: boolean;
  reason?: string;
  requestedBy: string;
  timeout: string; // ISO timestamp
  maxRetries: number;
  retryCount: number;
}

// Bulk correction event
export interface BulkCorrectionRequestedEvent {
  correctionRequestIds: string[];
  tenantId: string;
  corrections: Array<{
    correctionRequestId: string;
    originalAuditLogId: string;
    correctionToolName: string;
    correctionType: CorrectionType;
    requiresPreviousState: boolean;
  }>;
  reason?: string;
  requestedBy: string;
  timeout: string;
  maxRetries: number;
  retryCount: number;
}

// Correction types from control plane
export type CorrectionType =
  | 'archive'
  | 'amend'
  | 'delete'
  | 'refund'
  | 'credit'
  | 'void'
  | 'follow_up'
  | 'not_correctable';

// Correction execution input
export interface CorrectionExecutionInput {
  tenantId: string;
  correctionRequestId: string;
  originalAuditLogId: string;
  correctionToolName: string;
  correctionType: CorrectionType;
  requiresPreviousState: boolean;
  reason?: string;
  requestedBy: string;
  traceId: string;
  // Required for Tool Gateway execution
  agentId?: string;
  instructionVersion?: number;
}

// Correction execution result
export interface CorrectionExecutionResult {
  success: boolean;
  correctionAuditLogId?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

// Pre-action snapshot from Action Ledger
export interface PreActionSnapshot {
  resourceId: string;
  resourceType: string;
  data: Record<string, unknown>;
  fetchedAt: Date;
}

// Correction queue item for rate-limited execution
export interface CorrectionQueueItem {
  id: string;
  tenantId: string;
  correctionRequestId: string;
  correctionToolName: string;
  args: Record<string, unknown>;
  executeAfter: Date;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
}

// Resource validation result
export interface ResourceValidationResult {
  exists: boolean;
  error?: string;
  resourceType?: string;
}

// Control plane audit log creation request
export interface CreateAuditLogRequest {
  tenantId: string;
  action: string;
  inputArgs: Record<string, unknown>;
  outputSummary?: string;
  outcome: 'success' | 'error' | 'gated';
  errorCode?: string;
  triggeredBy: string;
  correctionOf: string;
}
