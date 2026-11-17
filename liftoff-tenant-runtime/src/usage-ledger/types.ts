// Usage Ledger Types
// Per Section 13: Usage events, action-credit ledger

export interface UsageEvent {
  id?: string;
  tenantId: string;
  agentId: string;
  workflowId: string | null;
  actionId: string | null;
  eventType: string;
  credits: number;
  metadata?: Record<string, any>;
  createdAt?: Date;
}

// Per Section 13: Live burn state
export interface BurnState {
  tenantId: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  includedCredits: number;
  usedCredits: number;
  remainingCredits: number;
  overageCredits: number;
  lastUpdated: Date;
}

export interface RefundInput {
  tenantId: string;
  actionId: string;
  credits: number;
  reason: string;
}
