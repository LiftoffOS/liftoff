import type { PoolClient } from 'pg';
import { AuditSource, CursorPayload, RawRow } from './types';

// Per-source select fragment. Each fragment selects canonical aliased columns,
// filters by tenant_id + time range, applies cursor predicate per-source, and
// LIMITs to (limit + 1). Sources that the union ORDER BY pulls from share the
// same column shape: (source, row_id, occurred_at, tenant_id, account_id, action,
// actor_id, previous_state, new_state).

function buildSourceFragments(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  cursor: CursorPayload | null,
  limitPlusOne: number,
): { fullSql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  // Helper that appends the cursor predicate for one source.
  //
  // The outer ORDER BY is `(occurred_at DESC, source ASC, row_id DESC)`. A
  // row from source S at timestamp T qualifies for the page AFTER the
  // cursor row (T_c, S_c, id_c) iff `(T, S, id_DESC)` strictly follows
  // `(T_c, S_c, id_c_DESC)` in that ordering. Mapped to per-source SQL:
  //
  //   - cursor source (S == S_c): `(time, id) < (T_c, id_c)` strict tuple.
  //   - source alphabetically AFTER cursor (S > S_c): `time <= T_c`
  //     (inclusive — rows at T_c are still "after" the cursor in outer order).
  //   - source alphabetically BEFORE cursor (S < S_c): `time < T_c` (strict
  //     — rows at T_c are "before" the cursor in outer order, already shown
  //     on the previous page). This is the fix for the duplicate-pagination
  //     bug at timestamp collisions across sources.
  function cursorPredicate(timeCol: string, idCol: string, source: AuditSource): {
    sql: string;
    params: unknown[];
  } {
    if (!cursor) return { sql: '', params: [] };
    if (cursor.source === source) {
      return {
        sql: ` AND (${timeCol}, ${idCol}::text) < (?::timestamptz, ?::text)`,
        params: [cursor.occurredAt, cursor.rowId],
      };
    }
    if (source > cursor.source) {
      // Inclusive: rows at the cursor timestamp on a later-alphabet source
      // were not yet shown.
      return {
        sql: ` AND ${timeCol} <= ?::timestamptz`,
        params: [cursor.occurredAt],
      };
    }
    // source < cursor.source: strict, exclude rows at cursor timestamp.
    return {
      sql: ` AND ${timeCol} < ?::timestamptz`,
      params: [cursor.occurredAt],
    };
  }

  // Helper that substitutes positional placeholders for pg ($1, $2 ...) into
  // a fragment SQL string. Each fragment uses '?' placeholders that this
  // function rewrites in order.
  function bind(sqlFragment: string, fragmentParams: unknown[]): string {
    let out = '';
    let i = 0;
    for (const ch of sqlFragment) {
      if (ch === '?') {
        params.push(fragmentParams[i++]);
        out += `$${params.length}`;
      } else {
        out += ch;
      }
    }
    return out;
  }

  // All UNION branches must agree on column types. `account_id` is UUID
  // in five sources and VARCHAR(255) in audit_log (where it's derived from
  // resource_id, which holds arbitrary resource identifiers — not always a
  // UUID). Postgres cannot implicitly unify uuid + character varying, so
  // every branch casts `account_id` to ::text. UUID-to-text is lossless
  // and matches the `string | null` shape RawRow already declares.
  // 1. tenant_member_audit
  {
    const cp = cursorPredicate('created_at', 'id', 'tenant_member_audit');
    const sql = `
      SELECT
        'tenant_member_audit'::text AS source,
        id::text AS row_id,
        created_at AS occurred_at,
        tenant_id,
        account_id::text AS account_id,
        action,
        actor_id,
        previous_state,
        new_state
      FROM tenant_member_audit
      WHERE tenant_id = ?
        AND created_at BETWEEN ? AND ?
        ${cp.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`;
    parts.push(bind(sql, [tenantId, startDate, endDate, ...cp.params, limitPlusOne]));
  }

  // 2. audit_log
  {
    const cp = cursorPredicate('timestamp', 'id', 'audit_log');
    const sql = `
      SELECT
        'audit_log'::text AS source,
        id::text AS row_id,
        timestamp AS occurred_at,
        tenant_id,
        (CASE WHEN resource_type = 'account' THEN resource_id ELSE NULL END)::text AS account_id,
        event_type AS action,
        user_id AS actor_id,
        previous_state,
        new_state
      FROM audit_log
      WHERE tenant_id = ?
        AND timestamp BETWEEN ? AND ?
        AND user_id IS NOT NULL
        AND deleted_at IS NULL
        ${cp.sql}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?`;
    parts.push(bind(sql, [tenantId, startDate, endDate, ...cp.params, limitPlusOne]));
  }

  // 3. internal_agent_audit
  {
    const cp = cursorPredicate('created_at', 'id', 'internal_agent_audit');
    const sql = `
      SELECT
        'internal_agent_audit'::text AS source,
        id::text AS row_id,
        created_at AS occurred_at,
        tenant_id,
        NULL::text AS account_id,
        ('agent.' || action)::varchar AS action,
        actor_id,
        NULL::jsonb AS previous_state,
        changes AS new_state
      FROM internal_agent_audit
      WHERE tenant_id = ?
        AND created_at BETWEEN ? AND ?
        AND actor_id IS NOT NULL
        ${cp.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`;
    parts.push(bind(sql, [tenantId, startDate, endDate, ...cp.params, limitPlusOne]));
  }

  // 4. agent_chat_messages
  {
    const cp = cursorPredicate('m.created_at', 'm.id', 'agent_chat_messages');
    const sql = `
      SELECT
        'agent_chat_messages'::text AS source,
        m.id::text AS row_id,
        m.created_at AS occurred_at,
        m.tenant_id,
        t.account_id::text AS account_id,
        'chat.message_sent'::varchar AS action,
        t.account_id AS actor_id,
        NULL::jsonb AS previous_state,
        jsonb_build_object(
          'thread_id', m.thread_id,
          'channel', t.channel,
          'thread_title', t.title,
          'agent_id', m.agent_id,
          'content', LEFT(m.content, 500)
        ) AS new_state
      FROM agent_chat_messages m
      JOIN agent_chat_threads t ON t.id = m.thread_id
      WHERE m.tenant_id = ?
        AND m.created_at BETWEEN ? AND ?
        AND m.role = 'user'
        ${cp.sql}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`;
    parts.push(bind(sql, [tenantId, startDate, endDate, ...cp.params, limitPlusOne]));
  }

  // 5. agent_audit_logs (human-triggered only)
  {
    const cp = cursorPredicate('created_at', 'id', 'agent_audit_logs');
    const sql = `
      SELECT
        'agent_audit_logs'::text AS source,
        id::text AS row_id,
        created_at AS occurred_at,
        tenant_id,
        NULL::text AS account_id,
        action,
        SUBSTRING(triggered_by FROM 7)::uuid AS actor_id,
        pre_action_snapshot AS previous_state,
        jsonb_build_object(
          'outcome', outcome,
          'internalAgentId', internal_agent_id,
          'externalAgentId', external_agent_id,
          'threadId', thread_id,
          'invocationId', invocation_id,
          'durationMs', duration_ms,
          'errorCode', error_code,
          'correctionOf', correction_of,
          'inputArgs', input_args,
          'outputSummary', output_summary
        ) AS new_state
      FROM agent_audit_logs
      WHERE tenant_id = ?
        AND created_at BETWEEN ? AND ?
        AND triggered_by LIKE 'human:%'
        ${cp.sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`;
    parts.push(bind(sql, [tenantId, startDate, endDate, ...cp.params, limitPlusOne]));
  }

  // 6. event_deliveries (inbound webhook deliveries — no human actor)
  {
    const cp = cursorPredicate('d.received_at', 'd.id', 'event_deliveries');
    const sql = `
      SELECT
        'event_deliveries'::text AS source,
        d.id::text AS row_id,
        d.received_at AS occurred_at,
        d.tenant_id,
        NULL::text AS account_id,
        ('webhook.delivery_' || d.status)::varchar AS action,
        NULL::uuid AS actor_id,
        NULL::jsonb AS previous_state,
        jsonb_build_object(
          'sourceId', d.source_id,
          'sourceName', s.name,
          'eventType', d.event_type,
          'status', d.status,
          'signatureValid', d.signature_valid,
          'byteSize', d.request_body_bytes,
          'eventId', d.event_id,
          'sha256', d.request_body_sha256,
          'matchedRuleIds', d.matched_rule_ids
        ) AS new_state
      FROM event_deliveries d
      JOIN event_sources s ON s.id = d.source_id
      WHERE d.tenant_id = ?
        AND d.received_at BETWEEN ? AND ?
        ${cp.sql}
      ORDER BY d.received_at DESC, d.id DESC
      LIMIT ?`;
    parts.push(bind(sql, [tenantId, startDate, endDate, ...cp.params, limitPlusOne]));
  }

  const fullSql = `
    WITH unified AS (
      ${parts.map((p) => `(${p})`).join(' UNION ALL ')}
    )
    SELECT * FROM unified
    ORDER BY occurred_at DESC, source ASC, row_id DESC
    LIMIT ${limitPlusOne}`;

  return { fullSql, params };
}

function dedupAgentLifecycle(rows: RawRow[]): RawRow[] {
  // Drop the internal_agent_audit row if a matching audit_log row exists
  // for the same agent at the same second — the audit_log version has
  // richer metadata so we prefer it.
  //
  // Both sides must publish a CONCRETE agent id for the match to apply.
  // If either side has a null/undefined id, we can't be confident they
  // describe the same agent, so we keep both rows. Without this guard a
  // pair like (audit_log no-id, internal_agent_audit no-id) at the same
  // second would falsely collapse into one row — distinct agent updates
  // would be silently merged.
  const auditLogKeys = new Set<string>();
  for (const r of rows) {
    if (r.source !== 'audit_log') continue;
    if (!r.action.startsWith('internal_agent.')) continue;
    const newState = r.new_state ?? {};
    const agentId = (newState.agentId ?? newState.id) as string | undefined;
    if (!agentId) continue;
    auditLogKeys.add(
      `${r.action}|${agentId}|${Math.floor(r.occurred_at.getTime() / 1000)}`,
    );
  }
  return rows.filter((r) => {
    if (r.source !== 'internal_agent_audit') return true;
    const newState = r.new_state ?? {};
    const agentId = (newState.id ?? newState.agentId) as string | undefined;
    if (!agentId) return true; // no id → can't safely dedup
    const normalized = r.action.replace(/^agent\./, 'internal_agent.');
    const key = `${normalized}|${agentId}|${Math.floor(r.occurred_at.getTime() / 1000)}`;
    return !auditLogKeys.has(key);
  });
}

class AuditLogRepository {
  /**
   * @returns `rows`: deduped result rows (capped at fetchSize).
   *          `rawCount`: rows returned by the DB before dedup. Callers
   *          combine this with the requested `limit` to compute `hasMore`
   *          correctly even when dedup trims the boundary row.
   */
  async listUnifiedAuditEntries(
    client: PoolClient,
    tenantId: string,
    startDate: Date,
    endDate: Date,
    cursor: CursorPayload | null,
    limit: number,
  ): Promise<{ rows: RawRow[]; rawCount: number }> {
    // Fetch `limit + 1` rows so the service can detect hasMore. The dedup
    // pass may drop some — that's reflected in `rows.length < rawCount`.
    const fetchSize = limit + 1;
    const { fullSql, params } = buildSourceFragments(
      tenantId,
      startDate,
      endDate,
      cursor,
      fetchSize,
    );
    const result = await client.query<RawRow>(fullSql, params);
    const deduped = dedupAgentLifecycle(result.rows);
    return { rows: deduped, rawCount: result.rows.length };
  }
}

export const auditLogRepository = new AuditLogRepository();
