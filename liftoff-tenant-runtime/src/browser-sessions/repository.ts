import type { PoolClient } from 'pg';
import { getPool, withTenantScope } from '../infrastructure/database';
import type { BrowserSession, BrowserSessionClosedReason, CarriedOnTask, ParkedBrowserTask, ReportFinishTo, StoredPageSnapshot, TakeoverHold } from './types';
import type { TakeoverEndReason } from './takeover-capture/repository';
import { answerIntervention, endInterventions } from './interventions';

function mapBrowserSessionRow(row: Record<string, unknown>): BrowserSession {
  const meta = (row.vendor_metadata as Record<string, unknown> | null) ?? {};
  const lastShotAtRaw = meta.last_screenshot_at as string | undefined;
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    agentId: row.agent_id as string,
    threadId: (row.thread_id ?? null) as string | null,
    invocationId: (row.invocation_id ?? null) as string | null,
    vendor: row.vendor as string,
    vendorSessionId: row.vendor_session_id as string,
    liveViewUrl: (meta.live_view_url as string | undefined) ?? null,
    createdAt: row.created_at as Date,
    lastUsedAt: (row.last_used_at ?? null) as Date | null,
    expiresAt: (row.expires_at ?? null) as Date | null,
    closedAt: (row.closed_at ?? null) as Date | null,
    closedReason: (row.closed_reason ?? null) as BrowserSessionClosedReason | null,
    takeoverState: (row.takeover_state ?? 'none') as 'none' | 'taken_over',
    takenOverAt: (row.taken_over_at ?? null) as Date | null,
    ownerAccountId: (row.owner_account_id ?? null) as string | null,
    callerSessionId: (row.caller_session_id ?? null) as string | null,
    currentUrl: (meta.current_url as string | undefined) ?? null,
    lastScreenshotObjectPath: (meta.last_screenshot_object_path as string | undefined) ?? null,
    lastScreenshotAt: lastShotAtRaw ? new Date(lastShotAtRaw) : null,
    viewport: readViewport(meta.viewport),
    currentUrlAt: typeof meta.current_url_at === 'string' && !Number.isNaN(new Date(meta.current_url_at).getTime())
      ? new Date(meta.current_url_at)
      : null,
    currentTitle: typeof meta.current_title === 'string' ? meta.current_title : null,
    pageSnapshot: readPageSnapshot(meta.page_snapshot),
    parkedTask: readParkedTask(meta.parked_task),
    carriedOnTask: readCarriedOnTask(meta.carried_on_task),
    reportFinishTo: readReportFinishTo(meta.report_finish_to),
  };
}

/** The result of a task that carried on, off the row. Anything malformed
 *  reads as absent, which the caller reports as still running. */
function readCarriedOnTask(raw: unknown): CarriedOnTask | null {
  const v = raw as Partial<CarriedOnTask> | null | undefined;
  if (!v || typeof v.taskId !== 'string' || typeof v.finishedAt !== 'string') return null;
  if (Number.isNaN(new Date(v.finishedAt).getTime())) return null;
  return {
    taskId: v.taskId,
    status: typeof v.status === 'string' ? v.status : '',
    message: typeof v.message === 'string' ? v.message : '',
    reason: typeof v.reason === 'string' ? v.reason : '',
    finishedAt: v.finishedAt,
  };
}

/** Where a carried-on task reports, off the row. Anything without a thread
 *  reads as none: the push has nowhere to land, and the collect tool is
 *  still there. */
function readReportFinishTo(raw: unknown): ReportFinishTo | null {
  const v = raw as Partial<ReportFinishTo> | null | undefined;
  if (!v || typeof v.threadId !== 'string' || !v.threadId) return null;
  if (typeof v.agentId !== 'string' || !v.agentId) return null;
  const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);
  return {
    threadId: v.threadId,
    agentId: v.agentId,
    ...(str(v.assistant) ? { assistant: str(v.assistant) as string } : {}),
    ...(str(v.internalAgentId) ? { internalAgentId: str(v.internalAgentId) as string } : {}),
    ...(str(v.invocationId) ? { invocationId: str(v.invocationId) as string } : {}),
    ...(str(v.senderAccountId) ? { senderAccountId: str(v.senderAccountId) as string } : {}),
    ...(str(v.senderUserId) ? { senderUserId: str(v.senderUserId) as string } : {}),
  };
}

/** A parked task off the row. Anything malformed reads as none: a task that
 *  cannot be resumed is a task that starts afresh, which is what happened
 *  before parking existed. */
function readParkedTask(raw: unknown): ParkedBrowserTask | null {
  const v = raw as Partial<ParkedBrowserTask> | null | undefined;
  if (!v || typeof v.objective !== 'string' || typeof v.parkedAt !== 'string' || !Array.isArray(v.actions)) return null;
  if (Number.isNaN(new Date(v.parkedAt).getTime())) return null;
  return {
    objective: v.objective,
    constraints: Array.isArray(v.constraints) ? v.constraints.filter((c): c is string => typeof c === 'string') : [],
    actions: (v.actions as Array<Record<string, unknown>>)
      .filter((a) => a && typeof a.action === 'string' && typeof a.kind === 'string')
      .map((a) => ({
        step: typeof a.step === 'number' ? a.step : 0,
        action: a.action as string,
        kind: a.kind as string,
        url: typeof a.url === 'string' ? a.url : '',
        pageChanged: typeof a.pageChanged === 'boolean' ? a.pageChanged : null,
        typed: a.typed === true,
      })),
    reason: typeof v.reason === 'string' ? v.reason : '',
    parkedAt: v.parkedAt,
    ...(typeof v.pageUrl === 'string' && v.pageUrl ? { pageUrl: v.pageUrl } : {}),
    ...(Array.isArray(v.files) && v.files.length > 0
      ? { files: v.files.filter((f): f is string => typeof f === 'string') }
      : {}),
  };
}

function readPageSnapshot(raw: unknown): StoredPageSnapshot | null {
  const v = raw as { id?: unknown; url?: unknown; takenAt?: unknown; controls?: unknown } | null | undefined;
  if (!v || typeof v.id !== 'string' || typeof v.url !== 'string' || typeof v.takenAt !== 'string' || !Array.isArray(v.controls)) return null;
  const controls = (v.controls as Array<Record<string, unknown>>).filter((c) =>
    c && typeof c.ref === 'string' && typeof c.role === 'string' && typeof c.name === 'string' && typeof c.nth === 'number')
    .map((c) => ({
      ref: c.ref as string, role: c.role as string, name: c.name as string, nth: c.nth as number,
      frameId: typeof c.frameId === 'string' ? c.frameId : null,
    }));
  return { id: v.id, url: v.url, takenAt: v.takenAt, controls };
}

function readViewport(raw: unknown): { width: number; height: number } | null {
  const v = raw as { width?: unknown; height?: unknown } | null | undefined;
  if (!v || typeof v.width !== 'number' || typeof v.height !== 'number') return null;
  return { width: v.width, height: v.height };
}

export async function getById(id: string): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM web_sessions WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

export async function getByVendorSessionId(
  vendorSessionId: string,
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM web_sessions WHERE vendor_session_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [vendorSessionId],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

export async function listForThread(
  tenantId: string,
  threadId: string,
  opts: { includeClosed: boolean },
): Promise<BrowserSession[]> {
  const pool = getPool();
  const where = opts.includeClosed
    ? `tenant_id = $1 AND thread_id = $2`
    : `tenant_id = $1 AND thread_id = $2 AND closed_at IS NULL`;
  const { rows } = await pool.query(
    `SELECT * FROM web_sessions
     WHERE ${where}
     ORDER BY created_at DESC`,
    [tenantId, threadId],
  );
  return rows.map(mapBrowserSessionRow);
}

/**
 * OPEN is not LIVE.
 *
 * A session's row is closed by the reaper, minutes after the vendor has
 * already released the browser at `expires_at`. In between, a row that
 * answers this lookup hands every caller a browser that is gone: the
 * navigation fails, the read fails, and asking for a fresh session does not
 * help, because the spawn only happens when this returns nothing. So an
 * expired row is not this thread's session, and the caller opens a new one
 * while the reaper closes the old one in its own time.
 *
 * `includeExpired` is for the paths whose job is to finish a session off —
 * closing the row, settling its cost — which must still be able to find it.
 *
 * `includeClosed` goes one further, and is for reading a RECORD rather than
 * using a browser: the result of a task that carried on lives on the
 * session's row, and the moment it is most likely to be collected is after
 * the session has ended. Collecting it used to be refused with "no active
 * browser session", with the answer sitting in the row the lookup skipped.
 */
export async function getActiveForThread(
  tenantId: string,
  threadId: string,
  opts: { includeExpired?: boolean; includeClosed?: boolean } = {},
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM web_sessions
     WHERE tenant_id = $1 AND thread_id = $2
       AND ($4::boolean OR closed_at IS NULL)
       AND ($3::boolean OR expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, threadId, opts.includeExpired === true || opts.includeClosed === true, opts.includeClosed === true],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

/** The run's live session, when a run rather than a thread opened one. */
export async function getActiveForInvocation(
  tenantId: string,
  invocationId: string,
  opts: { includeExpired?: boolean; includeClosed?: boolean } = {},
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM web_sessions
     WHERE tenant_id = $1 AND invocation_id = $2
       AND ($4::boolean OR closed_at IS NULL)
       AND ($3::boolean OR expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, invocationId, opts.includeExpired === true || opts.includeClosed === true, opts.includeClosed === true],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

/** The cached page: the safe URL, WHEN it was read (so the Browser block can
 *  order it against the newest hold action by explicit timestamps rather
 *  than `last_used_at`, which every touch restamps), and the title beside
 *  it, already bounded and redacted by the caller. */
export async function setCurrentUrl(
  vendorSessionId: string,
  url: string,
  title: string | null = null,
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE web_sessions
       SET vendor_metadata = COALESCE(vendor_metadata, '{}'::jsonb)
                             || jsonb_build_object('current_url', $2::text, 'current_url_at', now()::text)
                             || CASE WHEN $3::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('current_title', $3::text) END,
           last_used_at = now()
     WHERE vendor_session_id = $1 AND closed_at IS NULL
     RETURNING *`,
    [vendorSessionId, url, title],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

/** The last reading of the page's controls, on the row, so an action on
 *  another instance checks the same reading (pane-actions.ts). */
export async function setPageSnapshot(
  sessionId: string,
  snapshot: StoredPageSnapshot,
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE web_sessions
       SET vendor_metadata = COALESCE(vendor_metadata, '{}'::jsonb) || jsonb_build_object('page_snapshot', $2::jsonb)
     WHERE id = $1 AND closed_at IS NULL
     RETURNING *`,
    [sessionId, JSON.stringify(snapshot)],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

/** The result of a task that outlived the call that started it, kept on the
 *  row so the turn that comes back for it finds it on any instance.
 *
 *  WRITTEN EVEN TO A CLOSED SESSION, unlike the page reading and the
 *  viewport beside it. Those describe a live browser and mean nothing once
 *  it is gone; this is a record of what happened, and the session ending is
 *  exactly when it is most needed. A reaped session used to swallow the
 *  result of the task it was reaped out from under, and the person was told
 *  the work had produced nothing. */
export async function setCarriedOnTask(
  sessionId: string,
  task: CarriedOnTask | null,
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE web_sessions
       SET vendor_metadata = COALESCE(vendor_metadata, '{}'::jsonb) || jsonb_build_object('carried_on_task', $2::jsonb)
     WHERE id = $1
     RETURNING *`,
    [sessionId, task === null ? null : JSON.stringify(task)],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

/** Where a carried-on task is to report when it finishes, written by the
 *  layer that dispatched it — the only one that knows which thread, which AI
 *  team or assistant, and who was speaking. */
export async function setReportFinishTo(
  sessionId: string,
  report: ReportFinishTo | null,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE web_sessions
       SET vendor_metadata = COALESCE(vendor_metadata, '{}'::jsonb) || jsonb_build_object('report_finish_to', $2::jsonb)
     WHERE id = $1`,
    [sessionId, report === null ? null : JSON.stringify(report)],
  );
}

/**
 * Hold a session open while something is still using it.
 *
 * The reaper closes a session whose `expires_at` has passed, which is right
 * for one nobody is using and wrong for one with a task still running in it.
 * A task that outlives its turn can easily outlive the ten minutes a session
 * is given, and when it does the browser closes under, say, a video that is
 * still rendering, and the work is lost with it.
 *
 * Only ever pushes the expiry outwards, so a caller cannot shorten another's
 * lease by asking for less.
 */
export async function keepSessionAliveFor(sessionId: string, ms: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE web_sessions
        SET expires_at = GREATEST(COALESCE(expires_at, now()), now() + ($2::int * interval '1 millisecond'))
      WHERE id = $1 AND closed_at IS NULL`,
    [sessionId, Math.max(0, Math.floor(ms))],
  );
}

/** The task that stopped on this session without finishing, so the next run
 *  of the same task starts from where it got to rather than repeating what
 *  it already did. Null clears it. */
export async function setParkedTask(
  sessionId: string,
  parked: ParkedBrowserTask | null,
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE web_sessions
       SET vendor_metadata = COALESCE(vendor_metadata, '{}'::jsonb) || jsonb_build_object('parked_task', $2::jsonb)
     WHERE id = $1 AND closed_at IS NULL
     RETURNING *`,
    [sessionId, parked === null ? null : JSON.stringify(parked)],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

/** The viewport the pane reported, stored on the row so a later screenshot
 *  restores it instead of the constant. */
export async function setViewport(
  sessionId: string,
  viewport: { width: number; height: number },
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE web_sessions
       SET vendor_metadata = COALESCE(vendor_metadata, '{}'::jsonb)
                             || jsonb_build_object('viewport', jsonb_build_object('width', $2::int, 'height', $3::int))
     WHERE id = $1 AND closed_at IS NULL
     RETURNING *`,
    [sessionId, viewport.width, viewport.height],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

// Write-through path for the cached freeze-frame. Called from
// handleReadActiveBrowserSession after every successful Anchor screenshot fetch,
// and once more (best-effort) from the anchor session-end webhook when end_reason
// === 'idle_timeout'. The closed-or-open guard is intentionally absent — the
// webhook path runs BEFORE markClosed, and we want the value persisted whether
// the session is currently live or already torn down.
export async function setLastScreenshot(
  vendorSessionId: string,
  objectPath: string,
  takenAt: Date,
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE web_sessions
       SET vendor_metadata = COALESCE(vendor_metadata, '{}'::jsonb)
                             || jsonb_build_object(
                                  'last_screenshot_object_path', $2::text,
                                  'last_screenshot_at',          $3::text
                                )
     WHERE vendor_session_id = $1
     RETURNING *`,
    [vendorSessionId, objectPath, takenAt.toISOString()],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

// Most recently closed session for a (tenant, thread). Used by
// GetActiveSessionForThread + EnsureSessionForThread to populate
// last_closed_session in the response so the frontend can render the paused-
// frame UX without a second RPC.
export async function getMostRecentClosedForThread(
  tenantId: string,
  threadId: string,
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM web_sessions
     WHERE tenant_id = $1 AND thread_id = $2 AND closed_at IS NOT NULL
     ORDER BY closed_at DESC
     LIMIT 1`,
    [tenantId, threadId],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

// ── Session state: the ONLY writers of closed_at and takeover_state ─────────
//
// A takeover is a segment with a record of its own (browser_takeover_holds,
// migration 418), and the segment must open and close exactly when the
// session's state does. So every transition of `takeover_state` and every
// close of a session is one transaction here: the web_sessions update and the
// hold write commit together, and there is no crash window between them.
// `src/browser-sessions/__tests__/session-state-writers.test.ts` fails the
// build on a raw UPDATE of either column anywhere else.
//
// The holds table is FORCE RLS while web_sessions is not, so each of these
// reads the session's tenant first and runs under withTenantScope.

function mapTakeoverHoldRow(row: Record<string, unknown>): TakeoverHold {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    sessionId: row.session_id as string,
    threadId: (row.thread_id ?? null) as string | null,
    kind: row.kind === 'point' ? 'point' : 'takeover',
    startedAt: row.started_at as Date,
    endedAt: (row.ended_at ?? null) as Date | null,
    endReason: (row.end_reason ?? null) as TakeoverHold['endReason'],
    captureOwner: (row.capture_owner ?? null) as string | null,
    captureGeneration: Number(row.capture_generation ?? 0),
    captureLeaseUntil: (row.capture_lease_until ?? null) as Date | null,
    captureGap: row.capture_gap === true,
    gapReason: (row.gap_reason ?? null) as TakeoverHold['gapReason'],
  };
}

async function tenantOfSession(sessionId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ tenant_id: string }>(
    `SELECT tenant_id FROM web_sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.tenant_id ?? null;
}

/** End the open hold, answering its id, or null when none was open. The
 *  id is what a caller hands the conversation so the person's hand-back can
 *  be verified against the record. */
async function endOpenHold(
  client: PoolClient,
  sessionId: string,
  reason: TakeoverEndReason,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE browser_takeover_holds SET ended_at = now(), end_reason = $2
     WHERE session_id = $1 AND ended_at IS NULL
     RETURNING id`,
    [sessionId, reason],
  );
  return rows[0]?.id ?? null;
}

export interface StartTakeoverResult {
  session: BrowserSession;
  hold: TakeoverHold;
  /** True when the session was already taken over and this was a lease
   *  renewal from the pane's heartbeat rather than a new hold. */
  renewed: boolean;
}

/** Open a hold on the none -> taken_over transition, or renew the open one.
 *
 *  In ONE transaction: an OPEN session's takeover_state moves from none to
 *  taken_over and the hold is inserted with that session's tenant and thread.
 *  A renewal (already taken_over) restamps taken_over_at and returns the SAME
 *  open hold. The partial unique index is the final race guard: a competing
 *  start finds the conflict and re-reads the open hold instead of creating
 *  another.
 *
 *  During a rolling deploy an older hold may have no row in the new table; a
 *  renewal then creates one starting now, marked `never_attached`, rather than
 *  pretending to have observed the earlier period.
 *
 *  Null when the session is closed or missing. */
export async function startTakeover(sessionId: string): Promise<StartTakeoverResult | null> {
  const tenantId = await tenantOfSession(sessionId);
  if (!tenantId) return null;
  return withTenantScope(tenantId, async (client) => {
    const opened = await client.query(
      `UPDATE web_sessions
       SET takeover_state = 'taken_over', taken_over_at = NOW()
       WHERE id = $1 AND closed_at IS NULL AND takeover_state = 'none'
       RETURNING *`,
      [sessionId],
    );
    if (opened.rows[0]) {
      const session = mapBrowserSessionRow(opened.rows[0]);
      const inserted = await client.query(
        `INSERT INTO browser_takeover_holds (tenant_id, session_id, thread_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id) WHERE ended_at IS NULL DO NOTHING
         RETURNING *`,
        [session.tenantId, session.id, session.threadId],
      );
      const hold = inserted.rows[0]
        ? mapTakeoverHoldRow(inserted.rows[0])
        : await openHoldFor(client, session.id);
      if (!hold) throw new Error(`takeover hold for session ${session.id} neither inserted nor found`);
      // The person taking over is the answer to a pending request for them
      // to (migration 431): stamped on this transaction's own client, so the
      // hold and its answer commit together.
      await answerIntervention(client, session.id, hold.id);
      return { session, hold, renewed: false };
    }
    const renewed = await client.query(
      `UPDATE web_sessions
       SET taken_over_at = NOW()
       WHERE id = $1 AND closed_at IS NULL AND takeover_state = 'taken_over'
       RETURNING *`,
      [sessionId],
    );
    if (!renewed.rows[0]) return null;
    const session = mapBrowserSessionRow(renewed.rows[0]);
    const existing = await openHoldFor(client, session.id);
    if (existing) return { session, hold: existing, renewed: true };
    const created = await client.query(
      `INSERT INTO browser_takeover_holds (tenant_id, session_id, thread_id, capture_gap, gap_reason)
       VALUES ($1, $2, $3, true, 'never_attached')
       ON CONFLICT (session_id) WHERE ended_at IS NULL DO NOTHING
       RETURNING *`,
      [session.tenantId, session.id, session.threadId],
    );
    const hold = created.rows[0]
      ? mapTakeoverHoldRow(created.rows[0])
      : await openHoldFor(client, session.id);
    if (!hold) throw new Error(`takeover hold for session ${session.id} neither inserted nor found`);
    return { session, hold, renewed: true };
  });
}

async function openHoldFor(client: PoolClient, sessionId: string): Promise<TakeoverHold | null> {
  const { rows } = await client.query(
    `SELECT * FROM browser_takeover_holds WHERE session_id = $1 AND ended_at IS NULL`,
    [sessionId],
  );
  return rows[0] ? mapTakeoverHoldRow(rows[0]) : null;
}

export interface EndTakeoverResult {
  session: BrowserSession;
  /** The hold this release ended; null when none was open. */
  holdId: string | null;
}

/** End the takeover: takeover_state back to none and the open hold ended
 *  with `reason`, together, answering the ended hold's id. A request for
 *  the person to take over that this takeover did not answer (it was made
 *  after the hold opened) is cancelled with it. Null when the session is
 *  missing. */
export async function endTakeover(
  sessionId: string,
  reason: Exclude<TakeoverEndReason, 'session_closed'>,
): Promise<EndTakeoverResult | null> {
  const tenantId = await tenantOfSession(sessionId);
  if (!tenantId) return null;
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE web_sessions
       SET takeover_state = 'none', taken_over_at = NULL
       WHERE id = $1
       RETURNING *`,
      [sessionId],
    );
    if (!rows[0]) return null;
    const holdId = await endOpenHold(client, sessionId, reason);
    await endInterventions(client, sessionId, 'cancelled');
    return { session: mapBrowserSessionRow(rows[0]), holdId };
  });
}

/** End the open hold as `session_closed` BEFORE the vendor is told to stop
 *  the session.
 *
 *  Every close that stops the browser at the vendor first and writes the row
 *  after (endSession, the reaper, a run's end) kills the browser under the
 *  capture owner's CDP connection. Without this, the owner sees a disconnect
 *  on a hold that is still open and records `lost_owner`, and only then does
 *  closeSession end the hold — so a session a person ended themselves reads
 *  as an observation lost. Ending the hold first, as the close's opening act,
 *  means the disconnect finds it already ended and records nothing
 *  (releaseCapture writes only to an open hold), and the row still closes
 *  vendor-first, which is what keeps closed_reason honest about settlement.
 *
 *  If the vendor close then fails and the session stays open, the ended hold
 *  is not resurrected: the next heartbeat's startTakeover finds no open hold
 *  and opens a fresh one marked never_attached, so the unobserved stretch is
 *  recorded as a gap rather than papered over. Returns whether a hold was
 *  ended. A session with no takeover is a no-op. */
export async function endTakeoverHoldForClose(sessionId: string): Promise<boolean> {
  const tenantId = await tenantOfSession(sessionId);
  if (!tenantId) return false;
  return withTenantScope(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE browser_takeover_holds SET ended_at = now(), end_reason = 'session_closed'
       WHERE session_id = $1 AND ended_at IS NULL`,
      [sessionId],
    );
    return (rowCount ?? 0) > 0;
  });
}

/** Close the session and end any open hold with `session_closed`, together.
 *  Null when the session is missing or already closed, in which case nothing
 *  is written. */
export async function closeSession(
  sessionId: string,
  reason: BrowserSessionClosedReason,
): Promise<BrowserSession | null> {
  const tenantId = await tenantOfSession(sessionId);
  if (!tenantId) return null;
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE web_sessions
       SET closed_at = NOW(), closed_reason = $2
       WHERE id = $1 AND closed_at IS NULL
       RETURNING *`,
      [sessionId, reason],
    );
    if (!rows[0]) return null;
    await endOpenHold(client, sessionId, 'session_closed');
    // A request for the person to take over dies with the session.
    await endInterventions(client, sessionId, 'cancelled');
    return mapBrowserSessionRow(rows[0]);
  }).then(async (closed) => {
    if (!closed) return closed;
    // The recorder attached for the session's lifetime lets its connection
    // go with the session. Best effort, reached dynamically: the capture
    // module imports the vendor proxy, which imports the clients.
    try {
      const { endWarmSessionCapture } = await import('./takeover-capture/session-capture');
      await endWarmSessionCapture(closed.id, 'session_closed');
    } catch { /* nothing warm on this instance */ }
    return closed;
  });
}

export async function getActiveForCallerSession(
  tenantId: string,
  agentId: string,
  callerSessionId: string,
): Promise<BrowserSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM web_sessions
     WHERE tenant_id = $1 AND agent_id = $2 AND caller_session_id = $3
       AND closed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, agentId, callerSessionId],
  );
  return rows[0] ? mapBrowserSessionRow(rows[0]) : null;
}

export async function recordWebhookEvent(
  id: string,
  eventType: string,
  vendorSessionId: string | null,
  payload: unknown,
): Promise<{ inserted: boolean }> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO anchor_webhook_events (id, event_type, vendor_session_id, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, eventType, vendorSessionId, JSON.stringify(payload)],
  );
  return { inserted: result.rowCount === 1 };
}
