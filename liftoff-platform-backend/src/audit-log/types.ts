// Single source of truth for audit source identifiers. Used by:
//   - the AuditSource union type (compile-time exhaustiveness)
//   - the cursor decoder's runtime allowlist (cursor.ts)
//   - per-source SQL fragments in repository.ts
// Adding a new source means adding it here AND adding a matching SELECT
// fragment in buildSourceFragments — the union type prevents the other
// half from drifting silently.
export const AUDIT_SOURCES = [
  'tenant_member_audit',
  'audit_log',
  'internal_agent_audit',
  'agent_chat_messages',
  'agent_audit_logs',
  'event_deliveries',
] as const;

export type AuditSource = (typeof AUDIT_SOURCES)[number];

// SHAPE COMPATIBLE with existing services/tenants.ts AuditEntry — frontend reads
// exactly these fields; CSV writer at SettingsPage.tsx:437-444 is unchanged.
export interface AuditEntry {
  id: string;
  tenantId: string;
  accountId: string | null;
  action: string;
  actorId: string | null;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  createdAt: string;
}

export interface PaginatedAuditResponse {
  entries: AuditEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CursorPayload {
  occurredAt: string;
  source: AuditSource;
  rowId: string;
}

export interface RawRow {
  source: AuditSource;
  row_id: string;
  occurred_at: Date;
  tenant_id: string;
  account_id: string | null;
  action: string;
  actor_id: string | null;
  previous_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
}
