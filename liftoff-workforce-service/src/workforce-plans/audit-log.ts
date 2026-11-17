// Workforce Audit Log
//
// Writes audit events to BOTH:
//   1. Pino stdout (structured JSON) — picked up by log sinks / Cloud Logging
//   2. workforce_audit_log DB table (migration 010) — for compliance queries
//
// DB writes are fire-and-non-throwing: a failure is logged but never rethrows
// so the caller's main operation always completes.

import { getPool } from '../infrastructure/database.js';
import { log } from '../infrastructure/logging.js';

/**
 * Write an audit event.
 *
 * @param action     - Dot-separated action name, e.g. `workforce_plans.approved`.
 * @param subject    - Who performed the action.
 * @param data       - Structured data relevant to the action (stored as JSONB).
 * @param entityRef  - Optional entity reference for the affected record.
 */
export async function writeAuditLog(
  action: string,
  subject: { tenantId: string; userId?: string; accountId?: string },
  data: Record<string, unknown>,
  entityRef?: { entityType?: string; entityId?: string },
): Promise<void> {
  // 1. Pino structured log — always synchronous, always succeeds.
  log.info(
    {
      audit: true,
      action,
      tenantId: subject.tenantId,
      userId: subject.userId ?? subject.accountId,
      entityType: entityRef?.entityType,
      entityId: entityRef?.entityId,
      ...data,
    },
    action,
  );

  // 2. DB persistence — non-throwing.
  const accountId = subject.accountId ?? subject.userId ?? null;
  const entityType = entityRef?.entityType ?? null;
  const entityId = entityRef?.entityId ?? null;

  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO workforce_audit_log
         (tenant_id, account_id, action, entity_type, entity_id, data)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [subject.tenantId, accountId, action, entityType, entityId, JSON.stringify(data)],
    );
  } catch (err) {
    log.error(
      {
        action,
        tenantId: subject.tenantId,
        err: (err as Error).message,
      },
      'Failed to persist audit log to DB — event was still written to stdout',
    );
  }
}
