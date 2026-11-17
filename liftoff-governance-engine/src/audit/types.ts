// Audit Log Types
// Per implementation plan: Phase 6 Audit Logs

export interface AuditLogEntry {
  internalAgentId?: string;
  userId?: string;
  threadId?: string;
  invocationId?: string;
  externalAgentId?: string;  // External agent involved in A2A collaboration
  action: string;
  inputArgs: Record<string, unknown>;
  outputSummary?: string;
  outcome: 'success' | 'error' | 'gated';
  errorCode?: string;
  triggeredBy: string;
  durationMs?: number;
  preActionSnapshot?: Record<string, unknown> | null;
  postActionSnapshot?: Record<string, unknown> | null;
  externalResponse?: Record<string, unknown> | null;
  snapshotStatus?: string | null;
}

export interface AuditLog {
  id: string;
  tenantId: string;
  internalAgentId: string | null;
  userId: string | null;
  threadId: string | null;
  invocationId: string | null;
  externalAgentId: string | null;  // External agent involved in A2A collaboration
  action: string;
  inputArgs: Record<string, unknown>;
  outputSummary: string | null;
  outcome: 'success' | 'error' | 'gated';
  errorCode: string | null;
  triggeredBy: string;
  durationMs: number | null;
  preActionSnapshot: Record<string, unknown> | null;
  postActionSnapshot: Record<string, unknown> | null;
  externalResponse: Record<string, unknown> | null;
  snapshotStatus: string | null;
  createdAt: Date;
}

export interface ListAuditLogsQuery {
  internalAgentId?: string;
  threadId?: string;
  invocationId?: string;
  externalAgentId?: string;  // Filter by external agent
  action?: string;
  outcome?: 'success' | 'error' | 'gated';
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface ListAuditLogsResult {
  data: AuditLog[];
  total: number;
  limit: number;
  offset: number;
}
