// Audit Log Service
// Per implementation plan: Phase 6 Audit Logs

import { PoolClient } from 'pg';
import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { getPublisher } from '../events/publisher';
import {
  AuditLogEntry,
  AuditLog,
  ListAuditLogsQuery,
  ListAuditLogsResult,
} from './types';
import { redactPii } from '@liftoffos/proto-gen/dist/redaction';

const SENSITIVE_KEYS = [
  'password', 'token', 'secret', 'key',
  'credential', 'auth', 'apikey', 'api_key',
];
const MAX_VALUE_LENGTH = 1000;

/**
 * Sanitize an arbitrary value tree for storage in the audit log.
 *
 * Layer 1 — keys whose lowercased name contains any of SENSITIVE_KEYS
 * have their value replaced with '[REDACTED]' wholesale, without
 * inspecting contents. This kills credential-shaped fields cleanly.
 *
 * Layer 2 — string values everywhere else are run through `redactPii`
 * (pattern-based: SSN, credit card, IBAN, ABA routing, email, phone,
 * JWT, Bearer, AWS key). Objects and arrays recurse. Primitives pass
 * through.
 *
 * Strings longer than MAX_VALUE_LENGTH are truncated for storage size.
 *
 * Pure function: returns a new value; never mutates the input. Tool
 * execution, compensation, and rollback operate on raw inputs/snapshots
 * via the action-ledger and are unaffected by this function. Only the
 * stored audit-row copy is redacted.
 *
 * Limitations: pattern-based; does NOT catch names, addresses, narrative
 * health/financial content, or custom-format IDs. Audit-log access is
 * already operator-only and tenant-scoped; that access control is the
 * primary defense.
 */
export function sanitizeArgs(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const redacted = redactPii(value);
    return redacted.length > MAX_VALUE_LENGTH
      ? redacted.substring(0, MAX_VALUE_LENGTH) + '...[truncated]'
      : redacted;
  }

  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(sanitizeArgs);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.some(s => k.toLowerCase().includes(s))) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = sanitizeArgs(v);
    }
  }
  return out;
}

/**
 * Insert an immutable audit log entry.
 *
 * Called after every tool execution to record what happened.
 * Input args are sanitized to remove credentials and excessive PII.
 *
 * Per implementation plan: client is first parameter (use pool if not in transaction).
 */
export async function insertAuditLog(
  client: PoolClient | null,
  tenantId: string,
  entry: AuditLogEntry
): Promise<void> {
  const db = client || pool;
  await db.query(
    `INSERT INTO audit_logs (
       tenant_id,
       internal_agent_id,
       user_id,
       thread_id,
       invocation_id,
       external_agent_id,
       action,
       input_args,
       output_summary,
       outcome,
       error_code,
       triggered_by,
       duration_ms,
       pre_action_snapshot,
       post_action_snapshot,
       external_response,
       snapshot_status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      tenantId,
      entry.internalAgentId ?? null,
      entry.userId ?? null,
      entry.threadId ?? null,
      entry.invocationId ?? null,
      entry.externalAgentId ?? null,
      entry.action,
      JSON.stringify(sanitizeArgs(entry.inputArgs)),
      entry.outputSummary != null ? redactPii(entry.outputSummary) : null,
      entry.outcome,
      entry.errorCode ?? null,
      entry.triggeredBy,
      entry.durationMs ?? null,
      entry.preActionSnapshot !== undefined
        ? JSON.stringify(sanitizeArgs(entry.preActionSnapshot))
        : null,
      entry.postActionSnapshot !== undefined
        ? JSON.stringify(sanitizeArgs(entry.postActionSnapshot))
        : null,
      entry.externalResponse !== undefined
        ? JSON.stringify(sanitizeArgs(entry.externalResponse))
        : null,
      entry.snapshotStatus ?? null,
    ]
  );

  log.debug({
    tenantId,
    action: entry.action,
    outcome: entry.outcome,
    externalAgentId: entry.externalAgentId,
  }, 'Audit log entry created');

  void publishAuditEvent(tenantId, entry).catch((err) => {
    log.error({ err, tenantId, action: entry.action }, 'audit: pubsub publish failed');
  });
}

async function publishAuditEvent(
  tenantId: string,
  entry: AuditLogEntry,
): Promise<void> {
  const topicName = process.env.AUDIT_EVENTS_TOPIC;
  if (!topicName) {
    log.debug({ tenantId, action: entry.action }, 'audit: AUDIT_EVENTS_TOPIC not set, skipping publish');
    return;
  }

  let platformInternalAgentId: string | null = null;
  if (entry.internalAgentId) {
    try {
      const result = await pool.query(
        `SELECT internal_agent_id FROM internal_agent_runtime_mapping
         WHERE agent_id = $1 AND tenant_id = $2`,
        [entry.internalAgentId, tenantId],
      );
      platformInternalAgentId = result.rows[0]?.internal_agent_id ?? null;
    } catch (err) {
      log.warn(
        { tenantId, runtimeAgentId: entry.internalAgentId, error: (err as Error).message },
        'audit: failed to resolve internal_agent_id mapping',
      );
    }
  }

  const payload: Record<string, unknown> = {
    tenantId,
    action: entry.action,
    inputArgs: sanitizeArgs(entry.inputArgs),
    outcome: entry.outcome,
    triggeredBy: entry.triggeredBy,
  };
  if (platformInternalAgentId)                payload.internalAgentId = platformInternalAgentId;
  if (entry.externalAgentId)                  payload.externalAgentId = entry.externalAgentId;
  if (entry.threadId)                         payload.threadId = entry.threadId;
  if (entry.invocationId)                     payload.invocationId = entry.invocationId;
  if (entry.outputSummary)                    payload.outputSummary = redactPii(entry.outputSummary);
  if (entry.errorCode)                        payload.errorCode = entry.errorCode;
  if (entry.durationMs != null)               payload.durationMs = entry.durationMs;
  if (entry.preActionSnapshot !== undefined)  payload.preActionSnapshot = sanitizeArgs(entry.preActionSnapshot);
  if (entry.postActionSnapshot !== undefined) payload.postActionSnapshot = sanitizeArgs(entry.postActionSnapshot);
  if (entry.externalResponse !== undefined)   payload.externalResponse = sanitizeArgs(entry.externalResponse);
  if (entry.snapshotStatus !== undefined)     payload.snapshotStatus = entry.snapshotStatus;

  const publisher = getPublisher();
  await publisher.publish(
    topicName,
    {
      eventType: 'audit.agent_action',
      occurredAt: new Date().toISOString(),
      payload,
    },
    {
      attributes: {
        eventType: 'audit.agent_action',
        tenantId,
        schemaVersion: '1',
      },
    },
  );
}

/**
 * List audit logs with filtering and pagination.
 */
export async function listAuditLogs(
  tenantId: string,
  query: ListAuditLogsQuery
): Promise<ListAuditLogsResult> {
  const limit = Math.min(query.limit || 50, 100);
  const offset = query.offset || 0;

  const conditions: string[] = ['tenant_id = $1'];
  const values: unknown[] = [tenantId];
  let idx = 2;

  if (query.internalAgentId) {
    conditions.push(`internal_agent_id = $${idx++}`);
    values.push(query.internalAgentId);
  }
  if (query.threadId) {
    conditions.push(`thread_id = $${idx++}`);
    values.push(query.threadId);
  }
  if (query.invocationId) {
    conditions.push(`invocation_id = $${idx++}`);
    values.push(query.invocationId);
  }
  if (query.externalAgentId) {
    conditions.push(`external_agent_id = $${idx++}`);
    values.push(query.externalAgentId);
  }
  if (query.action) {
    conditions.push(`action ILIKE $${idx++}`);
    values.push(`%${query.action}%`);
  }
  if (query.outcome) {
    conditions.push(`outcome = $${idx++}`);
    values.push(query.outcome);
  }
  if (query.from) {
    conditions.push(`created_at >= $${idx++}`);
    values.push(query.from);
  }
  if (query.to) {
    conditions.push(`created_at <= $${idx++}`);
    values.push(query.to);
  }

  const whereClause = conditions.join(' AND ');

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT id, tenant_id, internal_agent_id, user_id, thread_id, invocation_id,
              external_agent_id, action, input_args, output_summary, outcome,
              error_code, triggered_by, duration_ms, created_at
       FROM audit_logs
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) AS total FROM audit_logs WHERE ${whereClause}`,
      values
    ),
  ]);

  return {
    data: dataResult.rows.map(mapAuditLog),
    total: parseInt(countResult.rows[0].total, 10),
    limit,
    offset,
  };
}

/**
 * Get a single audit log entry by ID.
 */
export async function getAuditLog(
  auditLogId: string,
  tenantId: string
): Promise<AuditLog | null> {
  const result = await pool.query(
    `SELECT * FROM audit_logs WHERE id = $1 AND tenant_id = $2`,
    [auditLogId, tenantId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return mapAuditLog(result.rows[0]);
}

/**
 * Get the most recent audit log entry for a tenant.
 */
export async function getLastAuditEntry(
  tenantId: string,
): Promise<{ action: string; target: string | null; createdAt: string } | null> {
  const result = await pool.query(
    `SELECT action, target, created_at
     FROM audit_logs
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    action: row.action as string,
    target: (row.target as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function mapAuditLog(row: Record<string, unknown>): AuditLog {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    internalAgentId: row.internal_agent_id as string | null,
    userId: row.user_id as string | null,
    threadId: row.thread_id as string | null,
    invocationId: row.invocation_id as string | null,
    externalAgentId: row.external_agent_id as string | null,
    action: row.action as string,
    inputArgs: typeof row.input_args === 'string'
      ? JSON.parse(row.input_args)
      : row.input_args as Record<string, unknown>,
    outputSummary: row.output_summary as string | null,
    outcome: row.outcome as 'success' | 'error' | 'gated',
    errorCode: row.error_code as string | null,
    triggeredBy: row.triggered_by as string,
    durationMs: row.duration_ms as number | null,
    preActionSnapshot: row.pre_action_snapshot as Record<string, unknown> | null,
    postActionSnapshot: row.post_action_snapshot as Record<string, unknown> | null,
    externalResponse: row.external_response as Record<string, unknown> | null,
    snapshotStatus: row.snapshot_status as string | null,
    createdAt: new Date(row.created_at as string),
  };
}
