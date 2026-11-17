// Audit Log Service
// Per implementation plan: Phase 6 Audit Logs

import { PoolClient } from 'pg';
import { pool, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import {
  AuditLogEntry,
  AuditLog,
  ListAuditLogsQuery,
  ListAuditLogsResult,
} from './types';
import { redactPii } from '@liftoffos/proto-gen/dist/redaction';

// Outbox endpoint that the worker will POST to on the control plane.
const AUDIT_OUTBOX_ENDPOINT = '/api/agent-audit-logs';

// Exported (plan v13 Change 5): the chat-turn attribution exporter includes
// these in the sanitizer CONTRACT FINGERPRINT so the PB matcher can verify
// both sides sanitize identically before matching.
export const SENSITIVE_KEYS = [
  'password', 'token', 'secret', 'key',
  'credential', 'auth', 'apikey', 'api_key',
];
export const MAX_VALUE_LENGTH = 1000;
export const TRUNCATION_SUFFIX = '...[truncated]';

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
 * via the action ledger and are unaffected by this function. Only the
 * stored audit-row copy (and the outbox copy shipped to the control
 * plane) is redacted.
 *
 * Limitations: pattern-based; does NOT catch names, addresses, DOB, or
 * custom-format IDs. Audit-log access is already operator-only and
 * tenant-scoped; that access control is the primary defense.
 */
export function sanitizeArgs(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const redacted = redactPii(value);
    return redacted.length > MAX_VALUE_LENGTH
      ? redacted.substring(0, MAX_VALUE_LENGTH) + TRUNCATION_SUFFIX
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
  // Migration 079 enabled fail-loud RLS on audit_logs:
  //   USING/WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)
  // When the caller passes a client, they are presumed to have already set
  // app.tenant_id on that connection (their transaction owns the scope).
  // When client is null, we MUST open our own tenant-scoped transaction —
  // otherwise the INSERT throws and (because most callers swallow errors)
  // the audit row vanishes silently.
  const insertSql = `INSERT INTO audit_logs (
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
       snapshot_status,
       source,
       idempotency_key,
       impersonated_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`;
  const insertParams = [
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
    entry.preActionSnapshot !== undefined ? JSON.stringify(sanitizeArgs(entry.preActionSnapshot)) : null,
    entry.postActionSnapshot !== undefined ? JSON.stringify(sanitizeArgs(entry.postActionSnapshot)) : null,
    entry.externalResponse !== undefined ? JSON.stringify(sanitizeArgs(entry.externalResponse)) : null,
    entry.snapshotStatus ?? null,
    entry.source ?? 'llm_loop',
    entry.idempotencyKey ?? null,
    entry.impersonatedBy ?? null,
  ];

  // Build the outbox payload for the control-plane delivery.
  // The local audit_logs.internal_agent_id stores the RUNTIME agent id
  // (misleading legacy column name). The control plane expects the platform
  // internal_agent_id, so we resolve it via internal_agent_runtime_mapping.
  // If no mapping exists we still enqueue with internalAgentId omitted — the
  // platform schema allows null and external-agent / HITL events still surface.
  const outboxPayload = await buildOutboxPayload(tenantId, entry);

  if (client) {
    // Caller's transaction — add both writes to the same connection so they
    // commit or roll back together. The outbox table has no RLS policy
    // (no tenant_id column) so no SET LOCAL is needed for it.
    await client.query(insertSql, insertParams);
    await client.query(
      `INSERT INTO control_plane_outbox (endpoint, payload)
       VALUES ($1, $2::jsonb)`,
      [AUDIT_OUTBOX_ENDPOINT, JSON.stringify(outboxPayload)]
    );
  } else {
    // Open a tenant-scoped transaction for the audit_logs INSERT (RLS requires
    // app.tenant_id to be set). Both writes land in the same transaction.
    await withTenantScope(tenantId, async (txnClient) => {
      await txnClient.query(insertSql, insertParams);
      await txnClient.query(
        `INSERT INTO control_plane_outbox (endpoint, payload)
         VALUES ($1, $2::jsonb)`,
        [AUDIT_OUTBOX_ENDPOINT, JSON.stringify(outboxPayload)]
      );
    });
  }

  log.debug({
    tenantId,
    action: entry.action,
    outcome: entry.outcome,
    externalAgentId: entry.externalAgentId,
  }, 'Audit log entry created');
}

/**
 * The platform-backend audit validator (SE-007) accepts only a fixed set of
 * triggeredBy shapes; a value it rejects is 400'd and the outbox drops the row
 * after retries (that's how Slack-attributed `human:slack:<uid>` audit rows were
 * silently lost). Coerce anything non-conforming to the nearest valid shape so
 * an audit row is never dropped for a format reason — preserving the namespace
 * where possible. The caller logs whenever this changes a value so new offenders
 * surface instead of vanishing. Mirrors the control plane's accepted grammar.
 */
const TRIGGERED_BY_CONTRACT =
  /^(human:[A-Za-z0-9_.:-]+|agent(:[a-f0-9-]+)?|cron|event:[a-zA-Z0-9_.-]+|system(:[a-zA-Z0-9_.-]+)?)$/;

export function conformTriggeredBy(triggeredBy: string): string {
  if (TRIGGERED_BY_CONTRACT.test(triggeredBy)) return triggeredBy;
  const colon = triggeredBy.indexOf(':');
  const base = colon === -1 ? triggeredBy : triggeredBy.slice(0, colon);
  const rawSuffix = colon === -1 ? '' : triggeredBy.slice(colon + 1);
  const clean = (allowColon: boolean): string => {
    // event/system suffixes forbid ':'; map it to the natural '.' hierarchy
    // separator instead of a generic '_'. human keeps ':' (namespaced ids).
    const pre = allowColon ? rawSuffix : rawSuffix.replace(/:/g, '.');
    return pre
      .replace(allowColon ? /[^A-Za-z0-9_.:-]/g : /[^A-Za-z0-9_.-]/g, '_')
      .replace(/^[:._-]+|[:._-]+$/g, '') || 'unknown';
  };
  switch (base) {
    case 'human':  return `human:${clean(true)}`;
    case 'event':  return `event:${clean(false)}`;
    case 'system': return `system:${clean(false)}`;
    case 'agent':  return 'agent';
    case 'cron':   return 'cron';
    default:       return 'system:unmapped';
  }
}

/**
 * Translate `agent:<RUNTIME_AGENT_ID>` into `agent:<INTERNAL_AGENT_ID>`.
 *
 * The two id spaces are disjoint (INV-TR-010). The control plane resolves a
 * triggering agent's name by querying `internal_agents.id`, so a runtime id sent
 * as-is matches zero rows and the Activity row shows no name — silently, because
 * a miss is indistinguishable from "no agent triggered this".
 *
 * Shared by BOTH audit paths on purpose. The outbox is one; the execution
 * service's direct `postAuditLogToControlPlane` is the other, and it is the one
 * that writes the terminal `agent_execution` row the Activity page actually
 * renders. Two copies of this rule would drift, and the drift would be invisible
 * for exactly the same reason the original bug was.
 *
 * Never throws and never blocks a write: an unresolvable id degrades to the
 * original value, which is no worse than not translating at all.
 */
export async function translateTriggeredByAgentId(
  triggeredBy: string,
  known: { runtimeAgentId?: string; internalAgentId?: string | null },
): Promise<string> {
  if (!triggeredBy?.startsWith('agent:')) return triggeredBy;
  const runtimeUuid = triggeredBy.slice('agent:'.length);
  if (!runtimeUuid) return triggeredBy;

  // Common case: the agent triggered itself (every sdk-hook tool-call entry, and
  // every self-wake / follow-up / verify continuation). Reuse the id the caller
  // already resolved rather than issuing a second query for the same row.
  if (runtimeUuid === known.runtimeAgentId) {
    return known.internalAgentId ? `agent:${known.internalAgentId}` : triggeredBy;
  }

  try {
    const r = await pool.query<{ internal_agent_id: string }>(
      `SELECT internal_agent_id FROM internal_agent_runtime_mapping WHERE agent_id = $1`,
      [runtimeUuid],
    );
    const otherPlatformId = r.rows[0]?.internal_agent_id ?? null;
    return otherPlatformId ? `agent:${otherPlatformId}` : triggeredBy;
  } catch (err) {
    log.warn(
      { runtimeTriggeredBy: triggeredBy, error: (err as Error).message },
      'Failed to resolve triggeredBy agent mapping (sending the runtime id unchanged)',
    );
    return triggeredBy;
  }
}

/**
 * Build the JSON payload that the outbox worker will POST to the control
 * plane. Resolves the runtime agent id → platform internal_agent_id mapping
 * so the outbox row is complete and the worker needs no extra DB lookups.
 *
 * Also translates the triggeredBy field when it contains a runtime agent UUID
 * (e.g. "agent:<RUNTIME_ID>") into the corresponding platform internal_agent_id
 * so the platform backend's triggeredByAgentName lookup against internal_agents.id
 * succeeds instead of always returning null.
 */
async function buildOutboxPayload(
  tenantId: string,
  entry: AuditLogEntry,
): Promise<Record<string, unknown>> {
  // Translate runtime agent id → platform internal agent id.
  let platformInternalAgentId: string | null = null;
  if (entry.internalAgentId) {
    try {
      const result = await pool.query(
        `SELECT internal_agent_id FROM internal_agent_runtime_mapping
         WHERE agent_id = $1 AND tenant_id = $2`,
        [entry.internalAgentId, tenantId]
      );
      platformInternalAgentId = result.rows[0]?.internal_agent_id ?? null;
    } catch (err) {
      log.warn(
        { tenantId, runtimeAgentId: entry.internalAgentId, error: (err as Error).message },
        'Failed to resolve internal_agent_id mapping for outbox payload (will send without)'
      );
    }
  }

  let resolvedTriggeredBy = await translateTriggeredByAgentId(entry.triggeredBy, {
    runtimeAgentId: entry.internalAgentId,
    internalAgentId: platformInternalAgentId,
  });

  // Guarantee the value conforms to the control plane's SE-007 triggeredBy
  // contract; coerce + log rather than let the outbox silently drop the row.
  const conformed = conformTriggeredBy(resolvedTriggeredBy);
  if (conformed !== resolvedTriggeredBy) {
    log.warn(
      { tenantId, action: entry.action, original: resolvedTriggeredBy, coerced: conformed },
      'Coerced non-conforming triggeredBy for audit outbox (would be rejected by control plane)'
    );
    resolvedTriggeredBy = conformed;
  }

  // The platform Zod schema rejects null for optional fields, so we omit any
  // field that doesn't have a value (undefined strips cleanly via JSON.stringify).
  const payload: Record<string, unknown> = {
    tenantId,
    action: entry.action,
    inputArgs: sanitizeArgs(entry.inputArgs),
    outcome: entry.outcome,
    triggeredBy: resolvedTriggeredBy,
  };
  if (platformInternalAgentId) payload.internalAgentId = platformInternalAgentId;
  // The local audit_logs INSERT records user_id, but this payload used to drop
  // it — so every row that reached the control plane was unattributed no matter
  // what the caller set. Forwarded now, so the start row and the terminal row a
  // single invocation writes agree about the human as well as the trigger.
  if (entry.userId) payload.userId = entry.userId;
  // Same omit-not-null rule as everything else here. Present only on a run a
  // support delegation session set in motion, and the only way the control
  // plane can learn it: the delegated request ended long before this row.
  if (entry.impersonatedBy) payload.impersonatedBy = entry.impersonatedBy;
  if (entry.externalAgentId) payload.externalAgentId = entry.externalAgentId;
  if (entry.threadId) payload.threadId = entry.threadId;
  if (entry.invocationId) payload.invocationId = entry.invocationId;
  if (entry.outputSummary) payload.outputSummary = redactPii(entry.outputSummary);
  if (entry.errorCode) payload.errorCode = entry.errorCode;
  if (entry.durationMs != null) payload.durationMs = entry.durationMs;
  if (entry.preActionSnapshot !== undefined) payload.preActionSnapshot = sanitizeArgs(entry.preActionSnapshot);
  if (entry.postActionSnapshot !== undefined) payload.postActionSnapshot = sanitizeArgs(entry.postActionSnapshot);
  if (entry.externalResponse !== undefined) payload.externalResponse = sanitizeArgs(entry.externalResponse);
  if (entry.snapshotStatus !== undefined) payload.snapshotStatus = entry.snapshotStatus;
  // The per-dispatch id (idempotency_key locally). Forwarded so the control
  // plane's copy carries the same join key a tool charge's cost row holds in
  // action_id — the per-call cost↔audit join has to work in the database
  // where the cost rows live.
  if (entry.idempotencyKey) payload.toolCallId = entry.idempotencyKey;

  return payload;
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
              error_code, triggered_by, duration_ms,
              pre_action_snapshot, post_action_snapshot, external_response, snapshot_status,
              created_at
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
    preActionSnapshot: (row.pre_action_snapshot as Record<string, unknown> | null) ?? null,
    postActionSnapshot: (row.post_action_snapshot as Record<string, unknown> | null) ?? null,
    externalResponse: (row.external_response as Record<string, unknown> | null) ?? null,
    snapshotStatus: row.snapshot_status as string | null,
    createdAt: new Date(row.created_at as string),
  };
}
