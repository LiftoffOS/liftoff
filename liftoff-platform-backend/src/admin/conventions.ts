// Admin API response conventions.
//
// Authenticated admin endpoints return `{ data, audit, healthCheck? }` on
// success; public (no-auth) state endpoints omit `audit` because they have
// no admin identity to echo. All endpoints return `{ error, detail?, field? }`
// on failure.
//
// `data` carries the resource payload, `audit` echoes the admin_action_audit
// row inline so curl users don't have to query it separately, and
// `healthCheck` (state-returning endpoints only — PR 3+ scope) surfaces
// invariants worth flagging post-mutation.
//
// See docs/admin-api.md for the canonical reference.

export interface AdminAuditRecord {
  actionId: string | null;
  action: string;
  actor: { accountId: string | null; email: string | null };
  timestamp: string;
  // Optional partial-failure surface — introduced by PR 5's enterprise-setup
  // endpoint per Q15. Other endpoints omit these fields entirely.
  status?: 'success' | 'partial_failure';
  failedStep?: string | null;
}

export interface AdminHealthCheck {
  ok: boolean;
  issues: string[];
}

export interface AdminSuccessEnvelope<T> {
  data: T;
  audit?: AdminAuditRecord;
  healthCheck?: AdminHealthCheck;
}

export interface AdminErrorEnvelope {
  error: string;
  detail?: string;
  field?: string;
}

// Authenticated admin endpoints pass an AdminAuditRecord (from logAdminAction)
// as the second argument. Public state endpoints pass `null` to indicate "no
// admin identity, omit the audit key entirely."
export function wrapAdminResponse<T>(
  data: T,
  audit: AdminAuditRecord | null,
  healthCheck?: AdminHealthCheck,
): AdminSuccessEnvelope<T> {
  const envelope: AdminSuccessEnvelope<T> = { data };
  if (audit !== null) envelope.audit = audit;
  if (healthCheck !== undefined) envelope.healthCheck = healthCheck;
  return envelope;
}

export function adminError(code: string, detail?: string, field?: string): AdminErrorEnvelope {
  const env: AdminErrorEnvelope = { error: code };
  if (detail !== undefined) env.detail = detail;
  if (field !== undefined) env.field = field;
  return env;
}
