// Addresses: SE-003, SE-005, SE-008

import { withTenantScope, withAdminScope } from '../infrastructure/database';
import { AgentAuditLog, InsertAgentAuditLogInput, AgentAuditLogFilters, PaginatedAuditLogs } from './types';
import { redactPii } from '@liftoffos/proto-gen/dist/redaction';

// [SE-003] Layer 1 — credential-shaped keys killed wholesale by name.
const SENSITIVE_KEYS = [
  'password', 'token', 'secret', 'key',
  'credential', 'auth', 'apikey', 'api_key',
];

// [SE-005] Max input_args size (64KB)
const MAX_INPUT_ARGS_SIZE = 65536;
const MAX_VALUE_LENGTH = 1000;

/**
 * Restricts the customer-facing activity feed to rows whose actor is an agent
 * the tenant actually owns.
 *
 * Platform-owned agents (CAIO, HRBP — `is_system = TRUE`, seeded by migrations
 * 193/194) carry `tenant_id IS NULL`, so under the tenant RLS policy
 * `USING (tenant_id = current_setting('app.current_tenant_id')::uuid)` the
 * LEFT JOIN onto `internal_agents` can never resolve them. Their rows used to
 * reach the feed with a null agent name, which the dashboard rendered as
 * "Unknown Agent" against machine-namespaced actions like
 * `caio.chat_turn.started`. The Activity page shows the agents a customer
 * created; platform infrastructure is not one of them.
 *
 * Expressed as "the id resolved" rather than an explicit id list on purpose:
 * under tenant scope the only ids that fail to resolve ARE the system agents
 * (internal_agents is never hard-deleted, and soft-deleted agents still join
 * because the join does not filter on deleted_at). A third system agent is
 * therefore covered the day it is seeded, with no constant to keep in sync.
 *
 * Rows are still written and retained in full — this filters the display
 * surface only, so the compliance record is untouched.
 */
const TENANT_OWNED_AGENT_ROWS = '(aal.internal_agent_id IS NULL OR ia.id IS NOT NULL)';

/**
 * Sanitize an arbitrary value tree for storage in the audit log.
 *
 * Layer 1 — keys whose lowercased name contains any of SENSITIVE_KEYS have
 * their value replaced with '[REDACTED]' wholesale, without inspecting
 * contents. This kills credential-shaped fields cleanly.
 *
 * Layer 2 — string values everywhere else are run through `redactPii`
 * (pattern-based: SSN, credit card, IBAN, ABA routing, email, phone, JWT,
 * Bearer, AWS key). Objects and arrays recurse. Primitives pass through.
 * Strings longer than MAX_VALUE_LENGTH are truncated for storage size.
 *
 * Canonical two-layer pattern shared with liftoff-governance-engine and the
 * tenant-runtime audit service via @liftoffos/proto-gen. Pure function;
 * never mutates the input.
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

export class AgentAuditLogsRepository {

  async insert(input: InsertAgentAuditLogInput): Promise<AgentAuditLog> {
    const argsJson = JSON.stringify(sanitizeArgs(input.inputArgs));

    // [SE-005] Enforce size limit
    if (argsJson.length > MAX_INPUT_ARGS_SIZE) {
      throw new Error(`input_args exceeds maximum size of ${MAX_INPUT_ARGS_SIZE} bytes`);
    }

    const result = await withTenantScope(input.tenantId, (client) => client.query(
      `INSERT INTO agent_audit_logs
       (tenant_id, internal_agent_id, user_id, thread_id, invocation_id, tool_call_id,
        external_agent_id, proxy_key_id, action, input_args, output_summary, outcome,
        error_code, triggered_by, duration_ms, correction_of,
        pre_action_snapshot, post_action_snapshot, external_response, snapshot_status,
        impersonated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING *`,
      [
        input.tenantId,
        input.internalAgentId ?? null,
        input.userId ?? null,
        input.threadId ?? null,
        input.invocationId ?? null,
        input.toolCallId ?? null,
        input.externalAgentId ?? null,
        input.proxyKeyId ?? null,
        input.action,
        argsJson,
        input.outputSummary != null ? redactPii(input.outputSummary).substring(0, 4096) : null,
        input.outcome,
        input.errorCode ?? null,
        input.triggeredBy,
        input.durationMs ?? null,
        input.correctionOf ?? null,
        input.preActionSnapshot !== undefined ? JSON.stringify(sanitizeArgs(input.preActionSnapshot)) : null,
        input.postActionSnapshot !== undefined ? JSON.stringify(sanitizeArgs(input.postActionSnapshot)) : null,
        input.externalResponse !== undefined ? JSON.stringify(sanitizeArgs(input.externalResponse)) : null,
        input.snapshotStatus ?? null,
        input.impersonatedBy ?? null,
      ]
    ));

    return this.mapRow(result.rows[0]);
  }

  async findById(tenantId: string, id: string): Promise<AgentAuditLog | null> {
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT aal.*,
              COALESCE(ia.role, ea.name) AS agent_name
       FROM agent_audit_logs aal
       LEFT JOIN internal_agents ia ON ia.id = aal.internal_agent_id
       LEFT JOIN external_agents ea ON ea.id = aal.external_agent_id
       WHERE aal.id = $1 AND aal.tenant_id = $2 AND ${TENANT_OWNED_AGENT_ROWS}`,
      [id, tenantId]
    ));
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    // Resolve triggered_by agent name if needed
    let triggeredByAgentName: string | null = null;
    if (typeof row.triggered_by === 'string' && row.triggered_by.startsWith('agent:')) {
      const uuid = row.triggered_by.slice(6);
      const triggerRows = await withAdminScope(
        { caller: 'agent-audit-logs/repository.findById', reason: 'resolve cross-tenant triggered_by agent name for display' },
        async (db) => db.query<{ role: string }>(
          'SELECT role FROM internal_agents WHERE id = $1::uuid',
          [uuid]
        )
      );
      triggeredByAgentName = triggerRows.rows[0]?.role ?? null;
    }
    return this.mapRow(row, triggeredByAgentName);
  }

  // [BE-006] Cursor-based pagination
  async list(
    tenantId: string,
    filters: AgentAuditLogFilters,
    limit: number = 50,
    cursor?: string
  ): Promise<PaginatedAuditLogs> {
    // Base WHERE (filters only, no cursor) drives the COUNT(*) for total —
    // the cursor narrows only the SELECT page slice, not the total set.
    const baseConditions: string[] = ['aal.tenant_id = $1', TENANT_OWNED_AGENT_ROWS];
    const baseParams: (string | Date | number)[] = [tenantId];
    let baseIdx = 2;

    if (filters.internalAgentId) {
      baseConditions.push(`aal.internal_agent_id = $${baseIdx++}`);
      baseParams.push(filters.internalAgentId);
    }
    if (filters.threadId) {
      baseConditions.push(`aal.thread_id = $${baseIdx++}`);
      baseParams.push(filters.threadId);
    }
    if (filters.invocationId) {
      baseConditions.push(`aal.invocation_id = $${baseIdx++}`);
      baseParams.push(filters.invocationId);
    }
    if (filters.externalAgentId) {
      baseConditions.push(`aal.external_agent_id = $${baseIdx++}`);
      baseParams.push(filters.externalAgentId);
    }
    if (filters.action) {
      baseConditions.push(`aal.action = $${baseIdx++}`);
      baseParams.push(filters.action);
    }
    if (filters.outcome) {
      baseConditions.push(`aal.outcome = $${baseIdx++}`);
      baseParams.push(filters.outcome);
    }
    if (filters.startDate) {
      baseConditions.push(`aal.created_at >= $${baseIdx++}`);
      baseParams.push(filters.startDate);
    }
    if (filters.endDate) {
      baseConditions.push(`aal.created_at <= $${baseIdx++}`);
      baseParams.push(filters.endDate);
    }
    // Free-text search across joined columns. Implemented as an OR over
    // ILIKE on agent name (LEFT-joined from internal_agents/external_agents),
    // action, the input_args JSONB serialised to text, and output_summary.
    // The pre-fix UI ran search purely client-side over the already-fetched
    // page, which meant a high-volume agent flooding the recent rows could
    // bury every other agent's entries past the client's window — searching
    // for a low-volume agent's role name returned nothing because those
    // rows never reached the client. Pushing the predicate to the DB scopes
    // the entire matching set and lets the cursor paginate through it.
    const trimmedQ = filters.q?.trim();
    let qPattern: string | null = null;
    if (trimmedQ && trimmedQ.length > 0) {
      qPattern = `%${trimmedQ}%`;
      baseConditions.push(
        `(COALESCE(ia.role, '') ILIKE $${baseIdx} OR
          COALESCE(ea.name, '') ILIKE $${baseIdx} OR
          aal.action ILIKE $${baseIdx} OR
          aal.input_args::text ILIKE $${baseIdx} OR
          COALESCE(aal.output_summary, '') ILIKE $${baseIdx})`,
      );
      baseParams.push(qPattern);
      baseIdx++;
    }
    const baseWhere = baseConditions.join(' AND ');

    // Items query layers cursor on top of the base WHERE.
    const itemConditions = [...baseConditions];
    const itemParams: (string | Date | number)[] = [...baseParams];
    let itemIdx = baseIdx;
    if (cursor) {
      itemConditions.push(`aal.id < $${itemIdx++}`);
      itemParams.push(cursor);
    }
    const itemWhere = itemConditions.join(' AND ');
    const cappedLimit = Math.min(limit, 1000);

    // The internal_agents join is unconditional: TENANT_OWNED_AGENT_ROWS
    // references ia.id, so the count must see it or the total would over-report
    // by exactly the platform-agent rows the items query drops. The
    // external_agents join is still only needed when q is active (that
    // predicate is the sole reader of ea.name).
    const countSql = qPattern
      ? `SELECT COUNT(*)::int AS total FROM agent_audit_logs aal
         LEFT JOIN internal_agents ia ON ia.id = aal.internal_agent_id
         LEFT JOIN external_agents ea ON ea.id = aal.external_agent_id
         WHERE ${baseWhere}`
      : `SELECT COUNT(*)::int AS total FROM agent_audit_logs aal
         LEFT JOIN internal_agents ia ON ia.id = aal.internal_agent_id
         WHERE ${baseWhere}`;

    const [itemResult, countResult] = await withTenantScope(tenantId, (client) => Promise.all([
      client.query(
        `SELECT aal.*,
                COALESCE(ia.role, ea.name) AS agent_name
         FROM agent_audit_logs aal
         LEFT JOIN internal_agents ia ON ia.id = aal.internal_agent_id
         LEFT JOIN external_agents ea ON ea.id = aal.external_agent_id
         WHERE ${itemWhere}
         ORDER BY aal.created_at DESC, aal.id DESC
         LIMIT $${itemIdx}`,
        [...itemParams, cappedLimit + 1]  // Fetch one extra to check hasMore
      ),
      client.query(countSql, baseParams),
    ]));

    const hasMore = itemResult.rows.length > cappedLimit;
    const pageRows = itemResult.rows.slice(0, cappedLimit);

    // Collect all triggered_by values that reference an agent UUID for cross-tenant name resolution.
    const triggerUUIDs = [...new Set(
      pageRows
        .map((r: any) => r.triggered_by as unknown)
        .filter((t): t is string => typeof t === 'string' && t.startsWith('agent:'))
        .map((t: string) => t.slice(6))
    )];

    const triggerNameMap = new Map<string, string>();
    if (triggerUUIDs.length > 0) {
      // withAdminScope bypasses RLS — intentional here because the triggering agent
      // may belong to a different tenant (e.g. a workforce supervisor cross-tenant call).
      // We only look up the role name for display; no tenant data is leaked.
      const triggerRows = await withAdminScope(
        { caller: 'agent-audit-logs/repository.list', reason: 'resolve cross-tenant triggered_by agent names for display' },
        async (db) => db.query<{ id: string; role: string }>(
          'SELECT id::text, role FROM internal_agents WHERE id = ANY($1::uuid[])',
          [triggerUUIDs]
        )
      );
      triggerRows.rows.forEach((r: { id: string; role: string }) => triggerNameMap.set(r.id, r.role));
    }

    const items = pageRows.map((row: any) => {
      let triggeredByAgentName: string | null = null;
      if (typeof row.triggered_by === 'string' && row.triggered_by.startsWith('agent:')) {
        const uuid = row.triggered_by.slice(6);
        triggeredByAgentName = triggerNameMap.get(uuid) ?? null;
      }
      return this.mapRow(row, triggeredByAgentName);
    });
    const lastItem = items[items.length - 1];
    const total = countResult.rows[0]?.total ?? 0;

    return {
      items,
      cursor: hasMore && lastItem ? lastItem.id : null,
      hasMore,
      total,
    };
  }

  private mapRow(row: any, triggeredByAgentName: string | null = null): AgentAuditLog {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      internalAgentId: row.internal_agent_id,
      userId: row.user_id,
      threadId: row.thread_id,
      invocationId: row.invocation_id,
      toolCallId: row.tool_call_id ?? null,
      externalAgentId: row.external_agent_id,
      proxyKeyId: row.proxy_key_id ?? null,
      action: row.action,
      inputArgs: row.input_args,
      outputSummary: row.output_summary,
      outcome: row.outcome,
      errorCode: row.error_code,
      triggeredBy: row.triggered_by,
      durationMs: row.duration_ms,
      correctionOf: row.correction_of,
      preActionSnapshot: row.pre_action_snapshot ?? null,
      postActionSnapshot: row.post_action_snapshot ?? null,
      externalResponse: row.external_response ?? null,
      snapshotStatus: row.snapshot_status ?? null,
      createdAt: row.created_at,
      agentName: row.agent_name ?? null,
      triggeredByAgentName,
    };
  }
}
