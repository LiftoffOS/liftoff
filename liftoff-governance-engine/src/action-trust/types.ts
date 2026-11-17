// Action-trust decisions ledger types.

export interface TrustResult {
  tier: 'watch' | 'queue' | 'auto';
  runs: number;
  passRate: number;
  distinctApprovers: number;
}

// The single-tenant wire contract for POST /action-trust/decisions.
// Rows never carry their own tenant on the wire; the envelope is single-tenant.
export interface PostDecisionsBody {
  tenantId: string;
  agentId: string;
  gateReason: string;
  approvalId?: string; // hitl_resolve source
  feedbackId?: string; // late_feedback source
  decisions: Array<{
    actionClass: string;
    decision: 'approved' | 'rejected';
    decidedBy: string;
    decidedAt: string;
    sourceKey: string; // '<approvalId|feedbackId>:<actionClass>'
  }>;
}

// The INSERT shape — constructed server-side from the envelope (tenant_id / agent_id /
// gate_reason / source are added server-side).
export interface DecisionRow {
  tenantId: string;
  agentId: string;
  actionClass: string;
  gateReason: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
  decidedAt: string;
  source: 'hitl_resolve' | 'late_feedback';
  sourceKey: string;
}
