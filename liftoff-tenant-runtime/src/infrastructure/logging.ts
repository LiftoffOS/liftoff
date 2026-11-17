// Tenant-runtime logging — delegates to @liftoffos/telemetry with the
// custom backend (matching the existing console-JSON output shape) and
// the tenant-runtime redactSecrets hook.

import {
  createLogger as createTelemetryLogger,
  withTraceContext as pkgWithTraceContext,
  getTraceContext as pkgGetTraceContext,
  setTraceContext as pkgSetTraceContext,
} from '@liftoffos/telemetry';
import type { Logger, LogEntry, LogLevel, TraceContext } from '@liftoffos/telemetry';
import { redactSecrets } from '../security/log-redactor';

export type { TraceContext, Logger };

// Backwards-compat shape — tenant-runtime historically exported LogEntry
// directly, so keep the name/shape for consumer code.
export type { LogEntry };
export type { LogLevel };

const rootLogger: Logger = createTelemetryLogger({
  backend: 'custom',
  level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
  redact: (entry) => redactSecrets(entry as Record<string, unknown>) as LogEntry,
  cloudTraceProjectId: process.env.GCP_PROJECT_ID,
});

export const logger = rootLogger;
export const log = rootLogger;

export {
  pkgWithTraceContext as withTraceContext,
  pkgGetTraceContext as getTraceContext,
  pkgSetTraceContext as setTraceContext,
};

// ==========================================
// Per Section 18: Audit logging for runtime
// Kept local — writes to console (not DB) since runtime has no audit_log table.
// ==========================================

export interface AuditEntry {
  timestamp: string;
  eventType: string;
  tenantId: string;
  agentId?: string;
  resourceType: string;
  resourceId: string;
  action: string;
  previousState?: Record<string, unknown>;
  newState?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  traceId?: string;
}

const auditBuffer: AuditEntry[] = [];
const AUDIT_FLUSH_INTERVAL_MS = 5000;
const AUDIT_BATCH_SIZE = 100;
let auditFlushTimer: NodeJS.Timeout | null = null;

function ensureAuditFlushTimer(): void {
  if (!auditFlushTimer) {
    auditFlushTimer = setInterval(flushAuditBuffer, AUDIT_FLUSH_INTERVAL_MS);
  }
}

async function flushAuditBuffer(): Promise<void> {
  if (auditBuffer.length === 0) return;
  const toFlush = auditBuffer.splice(0, auditBuffer.length);
  for (const entry of toFlush) {
    // Audit log entries write directly to stdout via console.info so they land
    // in Cloud Logging as their own structured payload (log_type: audit) —
    // they intentionally bypass the pino scrubLogger to keep audit field
    // names verbatim. This is the one allowed console.* call in src/.
    // eslint-disable-next-line r5/no-console-in-src
    console.info(JSON.stringify({ log_type: 'audit', ...entry }));
  }
}

export function logAudit(
  eventType: string,
  context: {
    tenantId: string;
    agentId?: string;
    resourceType?: string;
    resourceId?: string;
  },
  details: {
    action: string;
    previousState?: Record<string, unknown>;
    newState?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): void {
  const traceContext = pkgGetTraceContext();

  const entry: AuditEntry = {
    timestamp: new Date().toISOString(),
    eventType,
    tenantId: context.tenantId,
    agentId: context.agentId,
    resourceType: context.resourceType || eventType.split('.')[0],
    resourceId: context.resourceId || 'unknown',
    action: details.action,
    previousState: details.previousState,
    newState: details.newState,
    metadata: details.metadata,
    traceId: traceContext?.traceId,
  };

  auditBuffer.push(entry);
  ensureAuditFlushTimer();

  if (auditBuffer.length >= AUDIT_BATCH_SIZE) {
    flushAuditBuffer();
  }
}

export async function shutdownAuditLogger(): Promise<void> {
  if (auditFlushTimer) {
    clearInterval(auditFlushTimer);
    auditFlushTimer = null;
  }
  await flushAuditBuffer();
}
