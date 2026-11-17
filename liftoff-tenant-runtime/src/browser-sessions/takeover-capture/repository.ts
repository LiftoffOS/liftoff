// The Postgres half of takeover capture: who records a hold, and what they saw.
//
// Every statement here runs under the session's tenant (`withTenantScope`),
// because both tables are FORCE RLS and the raw pool would read nothing.
//
// Ownership is a LEASE on the hold row. One process claims it, renews it
// while its CDP connection is attached with the recorder installed, and
// releases it when that stops being true. The claim reads the previous
// generation under lock in the same statement, so a lapsed lease is visible
// at the moment it is taken over and the row says so (`lost_owner`). Every
// write of an action goes THROUGH the hold — owner, generation, still open —
// so a stale generation writes nothing without needing to know it is stale.
//
// Opening and ending a hold is not here. Those happen in ONE transaction with
// the `web_sessions` state change, in `browser-sessions/repository.ts`
// (`startTakeover`, `endTakeover`, `closeSession`), so there is no crash
// window between the two.

import { withTenantScope } from '../../infrastructure/database';
import {
  ACTIONS_PER_HOLD_CAP, VALUE_DISPOSITIONS,
  type TakeoverActionKind, type TakeoverActionRow, type ValueDisposition,
} from './action';


// A claim lasts 60 seconds unrenewed (the literal in both statements below).
// A process that dies takes its lease with it, and the next heartbeat on any
// instance re-claims within that window and records the gap.

/** The closed vocabulary of a hold's capture gap. `frame_unavailable` (424):
 *  a page or frame the person used that the recorder could not attach to;
 *  the capture stays live for the targets that did attach. */
export type CaptureGapReason = 'lost_owner' | 'cap' | 'disabled' | 'never_attached' | 'frame_unavailable';
export type TakeoverEndReason = 'released' | 'absent_driver' | 'expired' | 'session_closed';

/** Take the hold's capture lease if nobody holds a live one.
 *
 *  Returns the generation this process now owns, or null when another owner's
 *  lease is live (a renewal routed to a second instance is exactly that case,
 *  and it is not a gap). Any generation above 1 means a previous owner's lease
 *  lapsed and observation was lost; the same statement records that. */
export async function claimCapture(
  tenantId: string,
  holdId: string,
  owner: string,
): Promise<number | null> {
  const { rows } = await withTenantScope(tenantId, (client) =>
    client.query<{ capture_generation: number }>(
      `WITH prev AS (
         SELECT id, capture_generation
         FROM browser_takeover_holds
         WHERE id = $1 AND ended_at IS NULL
           AND (capture_owner IS NULL OR capture_lease_until < now())
         FOR UPDATE
       )
       UPDATE browser_takeover_holds h
       SET capture_owner       = $2,
           capture_generation  = prev.capture_generation + 1,
           capture_lease_until = now() + interval '60 seconds',
           capture_gap         = h.capture_gap OR prev.capture_generation > 0,
           gap_reason          = COALESCE(h.gap_reason, CASE WHEN prev.capture_generation > 0 THEN 'lost_owner' END)
       FROM prev WHERE h.id = prev.id
       RETURNING h.capture_generation`,
      [holdId, owner],
    ),
  );
  return rows[0] ? Number(rows[0].capture_generation) : null;
}

/** Extend the lease. False means the hold ended or another generation took
 *  over: the caller detaches locally and never closes the hold. */
export async function renewCapture(
  tenantId: string,
  holdId: string,
  owner: string,
  generation: number,
): Promise<boolean> {
  const { rows } = await withTenantScope(tenantId, (client) =>
    client.query<{ id: string }>(
      `UPDATE browser_takeover_holds
       SET capture_lease_until = now() + interval '60 seconds'
       WHERE id = $1 AND capture_owner = $2 AND capture_generation = $3 AND ended_at IS NULL
       RETURNING id`,
      [holdId, owner, generation],
    ),
  );
  return rows.length > 0;
}

/** Give the lease up and record the gap. `never_attached` when the recorder
 *  was never installed; `lost_owner` when an installed recorder later lost
 *  its session, even if the person took no actions in between. The next
 *  heartbeat's claim then starts the following generation.
 *
 *  Only on an OPEN hold. A hold that has already ended has nothing left to
 *  observe, so a disconnect after its end — the browser being stopped by the
 *  close that ended it — is not an interruption and must not be written as
 *  one. The lease columns on an ended hold are inert either way. */
export async function releaseCapture(
  tenantId: string,
  holdId: string,
  owner: string,
  generation: number,
  reason: 'never_attached' | 'lost_owner',
): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE browser_takeover_holds
       SET capture_owner = NULL, capture_lease_until = NULL,
           capture_gap = true, gap_reason = COALESCE(gap_reason, $4)
       WHERE id = $1 AND capture_owner = $2 AND capture_generation = $3 AND ended_at IS NULL`,
      [holdId, owner, generation, reason],
    ),
  );
}

/** Record a gap on a hold nobody is claiming: capture switched off, or an
 *  attach that failed before any claim could be made. The first reason wins. */
export async function markCaptureGap(
  tenantId: string,
  holdId: string,
  reason: CaptureGapReason,
): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `UPDATE browser_takeover_holds
       SET capture_gap = true, gap_reason = COALESCE(gap_reason, $2)
       WHERE id = $1`,
      [holdId, reason],
    ),
  );
}

export type InsertActionOutcome = 'inserted' | 'stale' | 'capped' | 'duplicate';

/** Write one action through the hold, under the cap, in one transaction.
 *
 *  The hold row is locked first so two binding deliveries cannot both count
 *  499 and both insert; the count is read after the lock; the insert happens
 *  only below the cap. A stale owner or generation, or an ended hold, finds no
 *  row to lock and writes nothing. The first refused action sets the `cap`
 *  gap on the hold. */
export async function insertAction(
  tenantId: string,
  holdId: string,
  owner: string,
  generation: number,
  action: TakeoverActionRow,
): Promise<InsertActionOutcome> {
  return withTenantScope(tenantId, async (client) => {
    const lock = await client.query<{ id: string }>(
      `SELECT id FROM browser_takeover_holds
       WHERE id = $1 AND capture_owner = $2 AND capture_generation = $3 AND ended_at IS NULL
       FOR UPDATE`,
      [holdId, owner, generation],
    );
    if (lock.rows.length === 0) return 'stale';
    const count = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM browser_takeover_actions WHERE hold_id = $1`,
      [holdId],
    );
    if (Number(count.rows[0]?.n ?? 0) >= ACTIONS_PER_HOLD_CAP) {
      await client.query(
        `UPDATE browser_takeover_holds
         SET capture_gap = true, gap_reason = COALESCE(gap_reason, 'cap')
         WHERE id = $1`,
        [holdId],
      );
      return 'capped';
    }
    const inserted = await client.query<{ seq: number }>(
      `INSERT INTO browser_takeover_actions
         (hold_id, tenant_id, generation, page_nonce, seq, kind, url, tag, role, name, input_type,
          value, value_disposition, detail,
          url_truncated, name_truncated, value_truncated, detail_truncated,
          url_protected_data_omitted, name_protected_data_omitted, detail_protected_data_omitted)
       SELECT h.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
              $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
       FROM browser_takeover_holds h
       WHERE h.id = $1 AND h.capture_owner = $12 AND h.capture_generation = $3 AND h.ended_at IS NULL
       ON CONFLICT DO NOTHING
       RETURNING seq`,
      [
        holdId, tenantId, generation, action.nonce, action.seq, action.kind, action.url,
        action.tag, action.role, action.name, action.inputType, owner,
        action.value, action.valueDisposition, action.detail,
        action.urlTruncated, action.nameTruncated, action.valueTruncated, action.detailTruncated,
        action.urlProtectedDataOmitted, action.nameProtectedDataOmitted, action.detailProtectedDataOmitted,
      ],
    );
    return inserted.rows.length > 0 ? 'inserted' : 'duplicate';
  });
}

/** A point the person made without taking over (432): one transaction
 *  inserting a hold of kind 'point', started and ended in the same instant
 *  as `released`, capture columns null, and its one action under generation
 *  0 with a nonce of its own. `insertAction` is not used: it requires the
 *  lease, and a point has none. The hold is already ended, so it coexists
 *  with an open takeover hold on the same session. A frame that could not
 *  be observed is a `frame_unavailable` gap on the hold. Returns the hold's
 *  id. */

/** Holds on a session that overlap an interval, for the task capture to
 *  drop the person's own actions from an assistant's trail. An open hold is
 *  returned with `endedAt: null`; the caller bounds it by the task's finish. */
export async function listHoldsOverlapping(
  tenantId: string,
  sessionId: string,
  from: Date,
  to: Date,
): Promise<Array<{ startedAt: Date; endedAt: Date | null }>> {
  const { rows } = await withTenantScope(tenantId, (client) =>
    client.query<{ started_at: Date; ended_at: Date | null }>(
      `SELECT started_at, ended_at
       FROM browser_takeover_holds
       WHERE session_id = $1
         AND started_at <= $3
         AND (ended_at IS NULL OR ended_at >= $2)
       ORDER BY started_at ASC`,
      [sessionId, from, to],
    ),
  );
  return rows.map((r) => ({ startedAt: r.started_at, endedAt: r.ended_at ?? null }));
}

// ── The read behind ListTakeoverActivity ────────────────────────────────────

export interface TakeoverHoldWithSession {
  id: string;
  /** 'takeover' for a hold the person drove, 'point' for a zero-length hold
   *  recording one pointed-at control (432). */
  kind: 'takeover' | 'point';
  startedAt: Date;
  endedAt: Date | null;
  endReason: TakeoverEndReason | null;
  captureGap: boolean;
  gapReason: CaptureGapReason | null;
  /** The joined session's state, from which the service computes `live`. */
  sessionClosedAt: Date | null;
  sessionTakeoverState: 'none' | 'taken_over';
  actions: TakeoverActionRead[];
  /** Older actions left out by a `newestActions` read. */
  actionsOmitted: number;
}

export interface TakeoverActionRead {
  kind: TakeoverActionKind;
  url: string;
  urlTruncated: boolean;
  urlProtectedDataOmitted: boolean;
  tag: string | null;
  role: string | null;
  name: string | null;
  nameTruncated: boolean;
  nameProtectedDataOmitted: boolean;
  inputType: string | null;
  value: string | null;
  valueTruncated: boolean;
  valueDisposition: ValueDisposition;
  detail: string | null;
  detailTruncated: boolean;
  detailProtectedDataOmitted: boolean;
  at: Date;
}

/** A stored disposition, or a thrown error for a value this code does not
 *  know: the mapper is exhaustive and never coerces. */
export function readValueDisposition(raw: unknown): ValueDisposition {
  if (typeof raw === 'string' && (VALUE_DISPOSITIONS as readonly string[]).includes(raw)) {
    return raw as ValueDisposition;
  }
  throw new Error(`browser_takeover_actions.value_disposition holds an unknown value: ${String(raw)}`);
}

export interface HoldCursor {
  startedAt: Date;
  id: string;
}

/** Newest holds first for a thread, `limit` at a time, from before `cursor`.
 *
 *  Keyed on `(started_at, id)` rather than the timestamp alone, so two holds
 *  that started in the same instant cannot be skipped between pages. One row
 *  past the limit is fetched to know whether an older page exists. Each hold
 *  carries its actions oldest first; with `newestActions` set, its newest N
 *  and the count of the older ones left out. With `holdId` set, exactly that
 *  hold on that thread, or nothing: a caller verifying a client's claim
 *  about a hand-back or a point names the hold it was told about. */
export async function listTakeoverHolds(
  tenantId: string,
  threadId: string,
  opts: { limit: number; before?: HoldCursor; holdId?: string; newestActions?: number },
): Promise<{ holds: TakeoverHoldWithSession[]; hasMore: boolean }> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT h.id, h.kind, h.started_at, h.ended_at, h.end_reason, h.capture_gap, h.gap_reason,
              s.closed_at AS session_closed_at, s.takeover_state AS session_takeover_state
       FROM browser_takeover_holds h
       JOIN web_sessions s ON s.id = h.session_id
       WHERE h.tenant_id = $1 AND h.thread_id = $2
         AND ($3::timestamptz IS NULL OR (h.started_at, h.id) < ($3::timestamptz, $4::uuid))
         AND ($6::uuid IS NULL OR h.id = $6::uuid)
       ORDER BY h.started_at DESC, h.id DESC
       LIMIT $5`,
      [tenantId, threadId, opts.before?.startedAt ?? null, opts.before?.id ?? null, opts.limit + 1, opts.holdId ?? null],
    );
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit) as Array<Record<string, unknown>>;
    const holdIds = page.map((r) => r.id as string);
    const actionsByHold = new Map<string, TakeoverActionRead[]>();
    const omittedByHold = new Map<string, number>();
    if (holdIds.length > 0) {
      const newest = opts.newestActions && opts.newestActions > 0 ? Math.floor(opts.newestActions) : null;
      // With a per-hold cap, the newest N of each hold are picked in the
      // database (a window over the same order the full read uses) and the
      // older ones counted, so a hold with hundreds of actions costs the
      // reader N rows rather than all of them.
      const actions = newest === null
        ? await client.query(
          `SELECT hold_id, kind, url, tag, role, name, input_type, at,
                  value, value_disposition, detail,
                  url_truncated, name_truncated, value_truncated, detail_truncated,
                  url_protected_data_omitted, name_protected_data_omitted, detail_protected_data_omitted
           FROM browser_takeover_actions
           WHERE hold_id = ANY($1::uuid[])
           ORDER BY at ASC, page_nonce ASC, seq ASC`,
          [holdIds],
        )
        : await client.query(
          `SELECT hold_id, kind, url, tag, role, name, input_type, at,
                  value, value_disposition, detail,
                  url_truncated, name_truncated, value_truncated, detail_truncated,
                  url_protected_data_omitted, name_protected_data_omitted, detail_protected_data_omitted,
                  rn, total
           FROM (
             SELECT a.*,
                    row_number() OVER (PARTITION BY hold_id ORDER BY at DESC, page_nonce DESC, seq DESC) AS rn,
                    count(*) OVER (PARTITION BY hold_id) AS total
             FROM browser_takeover_actions a
             WHERE hold_id = ANY($1::uuid[])
           ) ranked
           WHERE rn <= $2
           ORDER BY at ASC, page_nonce ASC, seq ASC`,
          [holdIds, newest],
        );
      for (const a of actions.rows as Array<Record<string, unknown>>) {
        if (newest !== null && a.total !== undefined) {
          omittedByHold.set(a.hold_id as string, Math.max(0, Number(a.total) - newest));
        }
        const list = actionsByHold.get(a.hold_id as string) ?? [];
        list.push({
          kind: a.kind as TakeoverActionKind,
          url: a.url as string,
          urlTruncated: a.url_truncated === true,
          urlProtectedDataOmitted: a.url_protected_data_omitted === true,
          tag: (a.tag ?? null) as string | null,
          role: (a.role ?? null) as string | null,
          name: (a.name ?? null) as string | null,
          nameTruncated: a.name_truncated === true,
          nameProtectedDataOmitted: a.name_protected_data_omitted === true,
          inputType: (a.input_type ?? null) as string | null,
          value: (a.value ?? null) as string | null,
          valueTruncated: a.value_truncated === true,
          valueDisposition: readValueDisposition(a.value_disposition),
          detail: (a.detail ?? null) as string | null,
          detailTruncated: a.detail_truncated === true,
          detailProtectedDataOmitted: a.detail_protected_data_omitted === true,
          at: a.at as Date,
        });
        actionsByHold.set(a.hold_id as string, list);
      }
    }
    return {
      hasMore,
      holds: page.map((r) => ({
        id: r.id as string,
        kind: r.kind === 'point' ? 'point' as const : 'takeover' as const,
        startedAt: r.started_at as Date,
        endedAt: (r.ended_at ?? null) as Date | null,
        endReason: (r.end_reason ?? null) as TakeoverEndReason | null,
        captureGap: r.capture_gap === true,
        gapReason: (r.gap_reason ?? null) as CaptureGapReason | null,
        sessionClosedAt: (r.session_closed_at ?? null) as Date | null,
        sessionTakeoverState: (r.session_takeover_state ?? 'none') as 'none' | 'taken_over',
        actions: actionsByHold.get(r.id as string) ?? [],
        actionsOmitted: omittedByHold.get(r.id as string) ?? 0,
      })),
    };
  });
}
