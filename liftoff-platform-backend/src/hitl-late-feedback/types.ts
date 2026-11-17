// HITL Late Feedback Types
// Per implementation plan: Late feedback for agent learning when decision window passes

// Gate reason types (matches frontend and tenant runtime)
export type GateReason =
  | 'level_1_gate'
  | 'destructive_gate'
  | 'super_destructive_gate'
  | 'sensitive_work'
  | 'communication_review';

// Pending tool call structure
export interface PendingToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Late feedback decision options
export type LateFeedbackDecision = 'would_approve' | 'would_reject';

// Late feedback record
export interface LateFeedback {
  id: string;
  tenantId: string;
  approvalId: string;
  agentId: string;
  internalAgentId: string | null;
  workflowId: string | null;
  hitlLevel: 1 | 2;
  toolCallsHash: string;
  pendingToolCalls: PendingToolCall[];
  gateReason: GateReason;
  decision: LateFeedbackDecision;
  decidedBy: string;
  decidedByRole: string;
  rejectionReason: string | null;
  approvalCreatedAt: Date;
  approvalExpiredAt: Date;
  feedbackProvidedAt: Date;
  syncedToRuntime: boolean;
  syncAttempts: number;
  lastSyncError: string | null;
  syncedAt: Date | null;
  createdAt: Date;
}

// Approval snapshot for late feedback (subset of HitlApproval)
export interface ApprovalSnapshot {
  id: string;
  agentId: string;
  internalAgentId?: string | null;
  workflowId?: string | null;
  hitlLevel: 1 | 2;
  toolCallsHash: string;
  pendingToolCalls: PendingToolCall[];
  reason: string;  // gate reason
  createdAt: string;
  expiresAt: string;
}

// Input for creating late feedback
export interface CreateLateFeedbackInput {
  tenantId: string;
  approval: ApprovalSnapshot;
  decision: LateFeedbackDecision;
  decidedBy: string;
  decidedByRole: string;
  rejectionReason?: string;
}

// Database row representation
export interface LateFeedbackRow {
  id: string;
  tenant_id: string;
  approval_id: string;
  agent_id: string;
  internal_agent_id: string | null;
  workflow_id: string | null;
  hitl_level: number;
  tool_calls_hash: string;
  pending_tool_calls: PendingToolCall[];
  gate_reason: string;
  decision: string;
  decided_by: string;
  decided_by_role: string;
  rejection_reason: string | null;
  approval_created_at: Date;
  approval_expired_at: Date;
  feedback_provided_at: Date;
  synced_to_runtime: boolean;
  sync_attempts: number;
  last_sync_error: string | null;
  synced_at: Date | null;
  created_at: Date;
}

// Convert database row to domain model
export function rowToLateFeedback(row: LateFeedbackRow): LateFeedback {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    approvalId: row.approval_id,
    agentId: row.agent_id,
    internalAgentId: row.internal_agent_id,
    workflowId: row.workflow_id,
    hitlLevel: row.hitl_level as 1 | 2,
    toolCallsHash: row.tool_calls_hash,
    pendingToolCalls: row.pending_tool_calls,
    gateReason: row.gate_reason as GateReason,
    decision: row.decision as LateFeedbackDecision,
    decidedBy: row.decided_by,
    decidedByRole: row.decided_by_role,
    rejectionReason: row.rejection_reason,
    approvalCreatedAt: row.approval_created_at,
    approvalExpiredAt: row.approval_expired_at,
    feedbackProvidedAt: row.feedback_provided_at,
    syncedToRuntime: row.synced_to_runtime,
    syncAttempts: row.sync_attempts,
    lastSyncError: row.last_sync_error,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
  };
}
