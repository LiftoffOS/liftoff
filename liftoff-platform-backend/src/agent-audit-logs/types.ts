// Addresses: SE-007 (triggered_by validation)

export type AuditOutcome = 'success' | 'error' | 'gated';

// [SE-007] Valid triggered_by prefixes
export type TriggeredByPrefix = 'human' | 'agent' | 'cron' | 'event';

export interface AgentAuditLog {
  id: string;
  tenantId: string;
  internalAgentId: string | null;
  userId: string | null;
  threadId: string | null;
  invocationId: string | null;
  /** Per-dispatch id from the runtime; equals the cost row's action_id for
   *  tool charges — the per-call cost↔audit join key (migration 445). */
  toolCallId: string | null;
  externalAgentId: string | null;  // External agent involved in A2A collaboration
  proxyKeyId: string | null;  // developer proxy/Claude Code proxy key UUID if this was a proxy request
  action: string;
  inputArgs: Record<string, unknown>;
  outputSummary: string | null;
  outcome: AuditOutcome;
  errorCode: string | null;
  triggeredBy: string;
  durationMs: number | null;
  correctionOf: string | null;  // Links to original action this corrects (for correction protocol)
  preActionSnapshot: Record<string, unknown> | null;
  postActionSnapshot: Record<string, unknown> | null;
  externalResponse: Record<string, unknown> | null;
  snapshotStatus: string | null;
  createdAt: Date;
  // Server-side resolved display fields (not stored columns)
  agentName: string | null;  // resolved from internal_agents.role OR external_agents.name
  triggeredByAgentName: string | null;  // name of the agent UUID in triggered_by field (cross-tenant)
}

export interface InsertAgentAuditLogInput {
  tenantId: string;
  internalAgentId?: string;
  userId?: string;
  threadId?: string;
  invocationId?: string;
  toolCallId?: string;
  externalAgentId?: string;  // External agent involved in A2A collaboration
  proxyKeyId?: string;  // developer proxy/Claude Code proxy key UUID if this was a proxy request
  action: string;
  inputArgs: Record<string, unknown>;
  outputSummary?: string;
  outcome: AuditOutcome;
  errorCode?: string;
  triggeredBy: string;
  durationMs?: number;
  correctionOf?: string;  // Links to original action this corrects (for correction protocol)
  preActionSnapshot?: Record<string, unknown> | null;
  postActionSnapshot?: Record<string, unknown> | null;
  externalResponse?: Record<string, unknown> | null;
  snapshotStatus?: string;
  /** The Liftoff operator's `accounts.id` when this run was set in motion by a
   *  support delegation session, otherwise absent. Travels from the control
   *  plane's chat turn out to tenant-runtime and back (PB migration 409,
   *  TR migration 379). Internal attribution only: the run is the customer's
   *  everywhere it is rendered. */
  impersonatedBy?: string;
}

export interface AgentAuditLogFilters {
  internalAgentId?: string;
  threadId?: string;
  invocationId?: string;
  externalAgentId?: string;  // Filter by external agent
  action?: string;
  outcome?: AuditOutcome;
  startDate?: Date;
  endDate?: Date;
  /** Free-text search across agent name (internal_agents.role /
   *  external_agents.name), action, input_args (JSON), and output_summary.
   *  Case-insensitive substring match. Pushes search to the DB so
   *  high-volume agents can't bury low-volume agents' rows beyond reach of
   *  client-side filtering on a single fetched page. */
  q?: string;
}

// [BE-006] Cursor-based pagination (consistent with existing codebase)
export interface PaginatedAuditLogs {
  items: AgentAuditLog[];
  cursor: string | null;  // Last item's id for cursor-based pagination
  hasMore: boolean;
  total: number;  // Total rows matching the filter (cursor excluded)
}
