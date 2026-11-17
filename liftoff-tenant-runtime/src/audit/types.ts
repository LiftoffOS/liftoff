// Audit Log Types
// Per implementation plan: Phase 6 Audit Logs

export type AuditSource = 'llm_loop' | 'sandbox_code' | 'sandbox_tool' | 'reflection_loop';

export interface AuditLogEntry {
  internalAgentId?: string;
  userId?: string;
  /** The Liftoff operator's `accounts.id` when a support delegation session set
   *  this run in motion. Written to audit_logs.impersonated_by (migration 379)
   *  and carried on the outbox payload to the control plane. Absent on every
   *  ordinary run: the presence of a value is the statement. */
  impersonatedBy?: string;
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
  /**
   * Where this audit event was produced from. Defaults to 'llm_loop' for
   * existing call sites; sandbox MCP callbacks set 'sandbox_code', sandbox
   * tool-event ingestion sets 'sandbox_tool'.
   */
  source?: AuditSource;
  /**
   * Retry-safety key. When set, INSERT becomes ON CONFLICT DO NOTHING against
   * the partial unique index uidx_audit_logs_tenant_idempotency. Omit for
   * one-shot writes where collapsing duplicates isn't needed.
   */
  idempotencyKey?: string;
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
