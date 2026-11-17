// Workforce plan state machine + CAIO chat shapes.
//
// State machine:
//   draft → pending_approval → approved → provisioning →
//     (provisioning_waiting_for_oauth ↔ provisioning) →
//     completed | failed | canceled

export type PlanStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'provisioning'
  | 'provisioning_waiting_for_oauth'
  | 'completed'
  | 'failed'
  | 'canceled';

export type ProposedAgentKind = 'template' | 'custom';

export interface ProposedAgent {
  name: string;
  role: string;
  kind: ProposedAgentKind;
  /** Populated when kind === 'template'. */
  templateId: string | null;
  systemPrompt: string;
  connectorTypes: string[];
}

export interface WorkforcePlan {
  id: string;
  tenantId: string;
  createdByUserId: string;
  status: PlanStatus;
  title: string;
  objective: string;
  proposedAgents: ProposedAgent[];
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  approvalCapabilityTokenId: string | null;
  provisionedAgentTemplateIds: string[];
  failureReason: string | null;
}

export interface PlanApproval {
  id: string;
  planId: string;
  approverUserId: string;
  decision: 'approved' | 'rejected';
  comments: string | null;
  createdAt: Date;
}

export interface PlanThread {
  id: string;
  planId: string;
  tenantId: string;
  createdByUserId: string;
  title: string;
  createdAt: Date;
  /** Null for committed plans (retained indefinitely); Date for drafts. */
  autoDeleteAt: Date | null;
}

export interface PlanMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Optional — populated when role === 'tool'. */
  toolName: string | null;
  toolInput: unknown;
  toolOutput: unknown;
  createdAt: Date;
}

export interface CaioMemoryEntry {
  id: string;
  tenantId: string;
  userId: string;
  /** Free-form PII-scrubbed summary line. */
  summary: string;
  /** 24-month TTL per Phase 3d. */
  expiresAt: Date;
  createdAt: Date;
}
