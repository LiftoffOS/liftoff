// Platform-backend logging — delegates to @liftoffos/telemetry's pino
// backend with the control-plane-specific audit-to-Postgres buffer kept
// local (the control plane has a `audit_log` table that the runtime
// doesn't have).

import { randomUUID } from 'node:crypto';
import {
  createLogger as createTelemetryLogger,
  withTraceContext as pkgWithTraceContext,
  getTraceContext as pkgGetTraceContext,
  setTraceContext as pkgSetTraceContext,
} from '@liftoffos/telemetry';
import { getCurrentTraceId } from './tracing';
import type { Logger, TraceContext } from '@liftoffos/telemetry';

export type { TraceContext };

export interface LogContext extends TraceContext {
  requestId?: string;
  userId?: string;
  operation?: string;
  adminId?: string;
  userEmail?: string;
  /** Support delegation only. `userId` above is the identity the request is
   *  being ANSWERED as; these two say who is really acting. Both absent on an
   *  ordinary request, so their presence is itself the signal.
   *  See src/support-delegation/middleware.ts. */
  actorUserId?: string;
  delegationSessionId?: string;
  /** The operator's ACCOUNT id (UUID), as opposed to actorUserId's Firebase
   *  uid. Written to audit_log.impersonated_by, which is a UUID column and a
   *  foreign key to accounts, so the Firebase uid is the wrong identifier
   *  there. */
  impersonatedBy?: string;
}

const rootLogger: Logger = createTelemetryLogger({
  backend: 'pino',
  level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
  cloudTraceProjectId: process.env.GCP_PROJECT_ID,
});

// Create a child logger with context.
export function createLogger(ctx: LogContext): Logger {
  return rootLogger.child({
    ...(ctx.tenantId && { tenant_id: ctx.tenantId }),
    ...(ctx.agentId && { agent_id: ctx.agentId }),
    ...(ctx.workflowId && { workflow_id: ctx.workflowId }),
    ...(ctx.taskId && { task_id: ctx.taskId }),
    ...(ctx.actionId && { action_id: ctx.actionId }),
    ...(ctx.requestId && { request_id: ctx.requestId }),
    ...(ctx.userId && { user_id: ctx.userId }),
    ...(ctx.operation && { operation: ctx.operation }),
  });
}

// Default logger for non-request contexts.
export const log = rootLogger;
export const logger = rootLogger;

// Re-export async context helpers so callers can bind tenant/agent
// context for a whole request scope.
export {
  pkgWithTraceContext as withTraceContext,
  pkgGetTraceContext as getTraceContext,
  pkgSetTraceContext as setTraceContext,
};

// ── Audit event types (control-plane domain) ─────────────────────────

export type AuditEventType =
  // Account events
  | 'account.created'
  | 'account.updated'
  | 'account.deleted'
  // Subscription events
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  // Entitlement events
  | 'entitlement.granted'
  | 'entitlement.revoked'
  | 'entitlement.updated'
  // Tenant events
  | 'tenant.created'
  | 'tenant.suspended'
  | 'tenant.activated'
  | 'tenant.deleted'
  // Deployment events
  | 'deployment.created'
  | 'deployment.updated'
  | 'deployment.deleted'
  // Model events
  | 'model.registered'
  | 'model.approved'
  | 'model.deprecated'
  | 'model.disabled'
  | 'model_config.updated'
  | 'model_config.deleted'
  | 'model_rollout.requested'
  | 'model_rollout.approved'
  | 'model_rollout.rejected'
  | 'model_rollout.started'
  | 'model_rollout.completed'
  | 'model_rollout.rolled_back'
  // Prompt events
  | 'prompt.created'
  | 'prompt.updated'
  | 'prompt.deleted'
  // Feature flag events
  | 'feature_flag.created'
  | 'feature_flag.updated'
  | 'feature_flag.deleted'
  // Admin events
  | 'admin.action'
  // Data management events
  | 'data.deletion_requested'
  | 'data.deletion_completed'
  | 'data.export_requested'
  | 'data.export_completed'
  // Billing events
  | 'billing.reconciliation_started'
  | 'billing.reconciliation_completed'
  | 'billing.event_replayed'
  // Human feedback events
  | 'feedback.submitted'
  | 'feedback.processed'
  // HITL
  | 'hitl.approved'
  | 'hitl.rejected'
  | 'hitl.late_feedback'
  // Oversight settings
  | 'oversight.updated'
  | 'oversight.rollback'
  // Web identity lifecycle (Phase 6 / 7 web-tools)
  | 'web_identity.revoke'
  // Generic
  | string;

export interface AuditEvent {
  id: string;
  eventType: AuditEventType;
  timestamp: Date;
  tenantId?: string;
  userId?: string;
  resourceType: string;
  resourceId: string;
  action: string;
  previousState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  traceId?: string;
  /** Set only when a support delegation session produced this row. NULL on
   *  every ordinary row, so its presence is the signal. */
  impersonatedBy?: string;
}

// ── Audit-to-Postgres buffer (control plane only) ─────────────────────

let auditBuffer: AuditEvent[] = [];
let flushTimeout: NodeJS.Timeout | null = null;
const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 5000;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validateUuid(value: string | undefined): string | null {
  if (!value) return null;
  return UUID_REGEX.test(value) ? value : null;
}

export function logAudit(
  action: string,
  ctx: LogContext,
  details: Record<string, unknown>,
): void {
  const auditLogger = createLogger(ctx);

  auditLogger.info(
    {
      audit: true,
      action,
      ...details,
    },
    action,
  );

  const event: AuditEvent = {
    // crypto.randomUUID() avoids the (very rare) collision risk of
    // Date.now()+Math.random() at high publish rates. PK column is
    // VARCHAR(255) so any string-prefixed ID format is acceptable.
    id: `audit-${randomUUID()}`,
    eventType: action,
    timestamp: new Date(),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    resourceType: extractResourceType(action),
    resourceId: extractResourceId(details),
    action: extractAction(action),
    previousState: details.previousState as Record<string, unknown> | undefined,
    newState: details.newState as Record<string, unknown> | undefined,
    metadata: sanitizeMetadata(details),
    traceId: getCurrentTraceId(),
    impersonatedBy: ctx.impersonatedBy,
  };

  auditBuffer.push(event);

  if (auditBuffer.length >= BATCH_SIZE) {
    flushAuditBuffer();
  } else if (!flushTimeout) {
    flushTimeout = setTimeout(flushAuditBuffer, FLUSH_INTERVAL_MS);
  }
}

function extractResourceType(action: string): string {
  const parts = action.split('.');
  return parts[0] || 'unknown';
}

function extractAction(action: string): string {
  const parts = action.split('.');
  return parts.slice(1).join('.') || action;
}

function extractResourceId(details: Record<string, unknown>): string {
  for (const field of [
    'id',
    'accountId',
    'tenantId',
    'subscriptionId',
    'modelId',
    'promptId',
    'flagId',
    'resourceId',
  ]) {
    if (details[field] && typeof details[field] === 'string') {
      return details[field] as string;
    }
  }
  return 'unknown';
}

// Keys that NAME a credential without carrying one. The substring match below
// redacts anything that looks like a secret, which is right for a value and
// wrong for an identifier: the workspace audit feed says which coding-tool
// credential an action came through (workspace-actions/audit.ts), and the id
// of an mcp_tokens row unlocks nothing on its own.
const IDENTIFIER_KEYS: ReadonlySet<string> = new Set(['credentialId']);

function sanitizeMetadata(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const sensitiveFields = ['password', 'token', 'secret', 'key', 'credential', 'accessToken', 'refreshToken'];
  for (const [key, value] of Object.entries(details)) {
    const lowerKey = key.toLowerCase();
    if (IDENTIFIER_KEYS.has(key)) {
      sanitized[key] = value;
    } else if (sensitiveFields.some((f) => lowerKey.includes(f))) {
      sanitized[key] = '[REDACTED]';
    } else if (key !== 'previousState' && key !== 'newState') {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

async function flushAuditBuffer(): Promise<void> {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }

  if (auditBuffer.length === 0) return;

  const events = [...auditBuffer];
  auditBuffer = [];

  try {
    const { withAdminScope } = await import('./database');

    const values = events
      .map((_, i) => {
        const offset = i * 13;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13})`;
      })
      .join(', ');

    const params = events.flatMap((e) => [
      e.id,
      e.eventType,
      e.timestamp.toISOString(),
      validateUuid(e.tenantId),
      validateUuid(e.userId),
      e.resourceType,
      e.resourceId,
      e.action,
      e.previousState ? JSON.stringify(e.previousState) : null,
      e.newState ? JSON.stringify(e.newState) : null,
      JSON.stringify(e.metadata),
      e.traceId,
      // Same validateUuid treatment as tenantId/userId: the column is UUID and
      // a bad value would reject the whole batch, taking unrelated rows with it.
      validateUuid(e.impersonatedBy),
    ]);

    // audit_log is a CONTENT table (holds NULL-tenant system rows) and this is a
    // MULTI-TENANT batched INSERT — rows span many tenants (+ NULL), so it cannot
    // be tenant-scoped. withAdminScope (BYPASSRLS) is the only correct primitive
    // under FORCE. Dynamic import avoids the logging<->database circular dependency.
    await withAdminScope(
      { caller: 'logging.flushAuditBuffer', reason: 'multi-tenant batched audit_log INSERT (rows span tenants + NULL system rows)' },
      (client) => client.query(
        `INSERT INTO audit_log (id, event_type, timestamp, tenant_id, user_id, resource_type, resource_id, action, previous_state, new_state, metadata, trace_id, impersonated_by)
         VALUES ${values}`,
        params,
      ),
    );
  } catch (error) {
    log.error(
      { error: (error as Error).message, eventCount: events.length },
      'Failed to flush audit buffer to database',
    );
    auditBuffer = [...events, ...auditBuffer].slice(0, BATCH_SIZE * 2);
  }
}

// Cross-service audit bridge: insert an audit row whose tenantId/userId/timestamp
// come from a remote producer (currently liftoff-connector-service and liftoff-billing).
// Bypasses the per-request LogContext wrapper because the producer's identity is
// authoritative. Reuses the same buffered batch pipeline as logAudit().
export function insertAuditLogDirect(event: Omit<AuditEvent, 'id'>): void {
  const fullEvent: AuditEvent = {
    // crypto.randomUUID() avoids the (very rare) collision risk of
    // Date.now()+Math.random() at high publish rates. PK column is
    // VARCHAR(255) so any string-prefixed ID format is acceptable.
    id: `audit-${randomUUID()}`,
    ...event,
  };
  auditBuffer.push(fullEvent);
  if (auditBuffer.length >= BATCH_SIZE) {
    void flushAuditBuffer();
  } else if (!flushTimeout) {
    flushTimeout = setTimeout(flushAuditBuffer, FLUSH_INTERVAL_MS);
  }
}

export async function shutdownAuditLogger(): Promise<void> {
  await flushAuditBuffer();
}

export function logError(error: Error, ctx: LogContext, message?: string): void {
  const errorLogger = createLogger(ctx);
  errorLogger.error(
    {
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
      },
    },
    message,
  );
}
