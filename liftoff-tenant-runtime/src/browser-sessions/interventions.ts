// A request for the person to take the browser over (browser_interventions,
// migration 431), and the gate it holds while pending.
//
// The assistant asks through `ask_person_to_take_over_browser_session` or
// the RequestIntervention RPC; the person's next takeover answers it
// (`answerIntervention`, called from `startTakeover` on the transaction's
// own client after the hold is inserted, so the request and its answer
// commit together); a withdraw, the session's close or a takeover that ends
// unanswered cancels it; and a pending request older than
// INTERVENTION_TTL_MS expires, on the next request and on every read, so a
// request nobody answered does not gate the browser forever.
//
// Every function takes an optional client: a caller already inside a
// tenant-scoped transaction hands its own in, and a caller with none gets a
// fresh scope. The table is FORCE RLS; nothing here touches the raw pool.
//
// The reason is bounded and passed through the browser text sanitizer
// before it lands, and it travels model-only: `toProto` puts it on the wire
// for the model's host, and the pane's JSON never carries it.

import type { PoolClient } from 'pg';
import { sanitizeBrowserText } from '@liftoffos/redact';
import { withTenantScope } from '../infrastructure/database';

/** A pending request nobody answered for this long expires. */
export const INTERVENTION_TTL_MS = 15 * 60_000;

/** Longest reason kept. */
export const INTERVENTION_REASON_CAP = 1_000;

export type InterventionStatus = 'pending' | 'answered' | 'cancelled' | 'expired';

export interface BrowserIntervention {
  id: string;
  tenantId: string;
  sessionId: string;
  threadId: string | null;
  requestedByInvocationId: string | null;
  reason: string;
  reasonTruncated: boolean;
  reasonProtectedDataOmitted: boolean;
  requestedAt: Date;
  status: InterventionStatus;
  holdId: string | null;
  answeredAt: Date | null;
  endedAt: Date | null;
}

function mapRow(row: Record<string, unknown>): BrowserIntervention {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    sessionId: row.session_id as string,
    threadId: (row.thread_id ?? null) as string | null,
    requestedByInvocationId: (row.requested_by_invocation_id ?? null) as string | null,
    reason: (row.reason ?? '') as string,
    reasonTruncated: row.reason_truncated === true,
    reasonProtectedDataOmitted: row.reason_protected_data_omitted === true,
    requestedAt: row.requested_at as Date,
    status: row.status as InterventionStatus,
    holdId: (row.hold_id ?? null) as string | null,
    answeredAt: (row.answered_at ?? null) as Date | null,
    endedAt: (row.ended_at ?? null) as Date | null,
  };
}

type Runner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

/** The caller's client when it has one, else a fresh tenant scope. */
function runnerFor(tenantId: string, client?: PoolClient): Runner {
  return client ? (fn) => fn(client) : (fn) => withTenantScope(tenantId, fn);
}

/** Expire pending requests on a session older than the TTL. Returns how
 *  many. The tenant is named in every statement here beside the row policy:
 *  a query that filters by session alone is only as isolated as the role
 *  running it, and the migration tests run as the database owner. */
async function expireStale(client: PoolClient, tenantId: string, sessionId: string): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE browser_interventions
       SET status = 'expired', ended_at = now()
     WHERE tenant_id = $3 AND session_id = $1 AND status = 'pending'
       AND requested_at < now() - ($2::int * interval '1 millisecond')`,
    [sessionId, INTERVENTION_TTL_MS, tenantId],
  );
  return rowCount ?? 0;
}

export interface RequestInterventionInput {
  tenantId: string;
  sessionId: string;
  threadId: string | null;
  reason: string;
  requestedByInvocationId?: string | null;
}

/** Ask. A pending request older than the TTL is expired first; a fresh one
 *  answers `alreadyPending` with the request that stands, and nothing new
 *  is made. */
export async function requestIntervention(
  input: RequestInterventionInput,
  client?: PoolClient,
): Promise<{ intervention: BrowserIntervention; alreadyPending: boolean }> {
  const reason = sanitizeBrowserText(input.reason, INTERVENTION_REASON_CAP);
  return runnerFor(input.tenantId, client)(async (c) => {
    await expireStale(c, input.tenantId, input.sessionId);
    const existing = await c.query(
      `SELECT * FROM browser_interventions WHERE tenant_id = $2 AND session_id = $1 AND status = 'pending'`,
      [input.sessionId, input.tenantId],
    );
    if (existing.rows[0]) return { intervention: mapRow(existing.rows[0]), alreadyPending: true };
    const inserted = await c.query(
      `INSERT INTO browser_interventions
         (tenant_id, session_id, thread_id, requested_by_invocation_id, reason, reason_truncated, reason_protected_data_omitted)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_id) WHERE status = 'pending' DO NOTHING
       RETURNING *`,
      [
        input.tenantId, input.sessionId, input.threadId, input.requestedByInvocationId ?? null,
        reason.text, reason.truncated, reason.protectedDataOmitted,
      ],
    );
    if (inserted.rows[0]) return { intervention: mapRow(inserted.rows[0]), alreadyPending: false };
    // A competing ask landed between the read and the insert.
    const raced = await c.query(
      `SELECT * FROM browser_interventions WHERE tenant_id = $2 AND session_id = $1 AND status = 'pending'`,
      [input.sessionId, input.tenantId],
    );
    if (!raced.rows[0]) throw new Error(`intervention for session ${input.sessionId} neither inserted nor found`);
    return { intervention: mapRow(raced.rows[0]), alreadyPending: true };
  });
}

/** The pending request on a session, expiring a stale one on the read. */
export async function pendingIntervention(
  tenantId: string,
  sessionId: string,
  client?: PoolClient,
): Promise<BrowserIntervention | null> {
  return runnerFor(tenantId, client)(async (c) => {
    await expireStale(c, tenantId, sessionId);
    const { rows } = await c.query(
      `SELECT * FROM browser_interventions WHERE tenant_id = $2 AND session_id = $1 AND status = 'pending'`,
      [sessionId, tenantId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  });
}

/** The person took over: the pending request is answered by this hold.
 *  Called from `startTakeover` on the transaction's own client, after the
 *  hold is inserted. Returns the answered request, or null when none was
 *  pending. */
export async function answerIntervention(
  client: PoolClient,
  sessionId: string,
  holdId: string,
): Promise<BrowserIntervention | null> {
  const { rows } = await client.query(
    `UPDATE browser_interventions
       SET status = 'answered', hold_id = $2, answered_at = now(), ended_at = now()
     WHERE session_id = $1 AND status = 'pending'
     RETURNING *`,
    [sessionId, holdId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** The request a hold answered, if any. */
export async function interventionForHold(
  tenantId: string,
  holdId: string,
  client?: PoolClient,
): Promise<BrowserIntervention | null> {
  return runnerFor(tenantId, client)(async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM browser_interventions WHERE tenant_id = $2 AND hold_id = $1 ORDER BY requested_at DESC LIMIT 1`,
      [holdId, tenantId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  });
}

/** The requests several holds answered, keyed by hold id, in one read. */
export async function interventionsForHolds(
  tenantId: string,
  holdIds: string[],
  client?: PoolClient,
): Promise<Map<string, BrowserIntervention>> {
  if (holdIds.length === 0) return new Map();
  return runnerFor(tenantId, client)(async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM browser_interventions WHERE tenant_id = $2 AND hold_id = ANY($1::uuid[]) ORDER BY requested_at ASC`,
      [holdIds, tenantId],
    );
    const out = new Map<string, BrowserIntervention>();
    for (const row of rows as Array<Record<string, unknown>>) out.set(row.hold_id as string, mapRow(row));
    return out;
  });
}

/** End the pending request on a session as `cancelled`: a withdraw, the
 *  session's close (from `repository.closeSession`, the close every path
 *  uses), or a takeover that ended with the request unanswered. Returns how
 *  many were ended. */
export async function endInterventions(
  client: PoolClient | undefined,
  sessionId: string,
  status: 'cancelled' | 'expired',
  tenantId?: string,
): Promise<number> {
  const run = async (c: PoolClient) => {
    // On the caller's own client (a hold writer's transaction) the tenant is
    // the scope's; named here too when the caller has it.
    const { rowCount } = tenantId
      ? await c.query(
        `UPDATE browser_interventions
           SET status = $2, ended_at = now()
         WHERE tenant_id = $3 AND session_id = $1 AND status = 'pending'`,
        [sessionId, status, tenantId],
      )
      : await c.query(
        `UPDATE browser_interventions
           SET status = $2, ended_at = now()
         WHERE session_id = $1 AND status = 'pending'`,
        [sessionId, status],
      );
    return rowCount ?? 0;
  };
  if (client) return run(client);
  if (!tenantId) throw new Error('endInterventions needs a client or a tenant');
  return withTenantScope(tenantId, run);
}

/** The sentence a mutating browser tool or RPC answers while a request is
 *  pending. One spelling, everywhere the gate holds. */
export function interventionGateMessage(reason: string): string {
  return `You asked the person to take over the browser (${reason}). Until they do, or you withdraw the request with `
    + 'ask_person_to_take_over_browser_session, you can read the browser but not act in it.';
}
