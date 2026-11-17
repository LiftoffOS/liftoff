import { randomUUID } from 'node:crypto';
import { ConnectError, Code, type ConnectRouter, type HandlerContext, type Interceptor } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import type { Timestamp } from '@bufbuild/protobuf/wkt';
import {
  BrowserSessionsService,
  BrowserSessionSchema,
  PendingInterventionSchema,
  StreamSessionEventsResponseSchema,
  ListSessionsForThreadResponseSchema,
  GetActiveSessionForThreadResponseSchema,
  CreateSessionForThreadResponseSchema,
  PauseSessionResponseSchema,
  ResumeSessionResponseSchema,
  StreamSessionEventsResponse_Type,
  EnsureSessionForThreadResponseSchema,
  EnsureSessionErrorSchema,
  EndSessionResponseSchema,
  GotoResponseSchema,
  GetPageStateResponseSchema,
  RunBrowserTaskResponseSchema,
  BrowserTaskTrailSchema,
  BrowserTaskStepSchema,
  ListTakeoverActivityResponseSchema,
  ListBrowserActivityResponseSchema,
  SnapshotPageResponseSchema,
  PageControlSchema,
  ActOnPageResponseSchema,
  RequestInterventionResponseSchema,
  type SnapshotPageRequest,
  type ActOnPageRequest,
  type RequestInterventionRequest,
  type ListBrowserActivityRequest,
  type ListTakeoverActivityRequest,
  type ListSessionsForThreadRequest,
  type GetActiveSessionForThreadRequest,
  type CreateSessionForThreadRequest,
  type PauseSessionRequest,
  type ResumeSessionRequest,
  type StreamSessionEventsRequest,
  type EnsureSessionForThreadRequest,
  type EndSessionRequest,
  type GotoRequest,
  type GetPageStateRequest,
  type RunBrowserTaskRequest,
  type SetViewportRequest,
  SetViewportResponseSchema,
  ViewportSchema,
  type ListSessionDownloadsRequest,
  ListSessionDownloadsResponseSchema,
  SessionDownloadSchema,
  type FetchSessionFileRequest,
  FetchSessionFileResponseSchema,
  type CheckBrowserTaskRequest,
  CheckBrowserTaskResponseSchema,
  type BrowserSession as ProtoBrowserSession,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';
import { sanitizeBrowserText } from '@liftoffos/redact';
import * as repo from './repository';
import * as vendorOps from './session-vendor-proxy';
import { ensureTakeoverCapture } from './takeover-capture';
import { listTakeoverHolds, type HoldCursor } from './takeover-capture/repository';
import { recordedUrl } from './takeover-capture/route-template';
import { listBrowserActivity, recordBrowserActivity, type ActivityCursor } from './activity-repository';
import { activityRowToProto, dateToTimestamp, holdToProto } from './activity-wire';
import { interventionForHold, interventionsForHolds, requestIntervention, endInterventions } from './interventions';
import { snapshotPage, actOnPage, PaneUnavailable, PANE_ACTION_KINDS, type PaneAction } from './pane-actions';
import { listDownloadsForSession, fetchFileForSession } from './downloads';
import { navigateAndRecord, PAGE_TITLE_CAP } from './navigate-and-record';
import { uploadScreenshotAndSign, signObjectPath } from './screenshot-storage';
import { persistCurrentUrl } from './current-url';
import { dropConnection, withPage, PANE_DIMENSIONS } from './cdp-page';
import { isVendorSessionGone } from './session-errors';
import { interventionGateMessage, pendingIntervention } from './interventions';
import { getBrowserSessionEmitter, emitBrowserSessionEvent } from './events';
import { classifyEnsureError } from './ensure-error-classifier';
import { logger } from '../infrastructure/logging';
import type { BrowserSession, BrowserSessionEvent } from './types';

// pg driver throws errors with .code === '23505' for unique-constraint violations.
function isPgUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

/** The session a thread-scoped RPC names: the caller was authorized on
 *  `threadId`, so a session that is not that thread's is NotFound, never
 *  acted on. */
async function sessionForThread(tenantId: string, sessionId: string, threadId: string): Promise<BrowserSession> {
  const session = await repo.getById(sessionId);
  if (!session || session.tenantId !== tenantId) throw new ConnectError('session not found', Code.NotFound);
  if (!threadId || session.threadId !== threadId) throw new ConnectError('session not found', Code.NotFound);
  return session;
}

// Connect masks any non-ConnectError thrown by a handler as a generic
// "[internal] internal error", which is undebuggable from the dashboard (an
// Anchor API failure, a screenshot/GCS error, a DB error — all collapse to the
// same opaque message). This interceptor logs the real error server-side AND
// rethrows it as a ConnectError carrying the actual message, so platform-backend
// (and its logs) see what really happened. Structured ConnectErrors raised
// deliberately by handlers (NotFound, PermissionDenied, …) pass through untouched.
export const browserSessionsErrorInterceptor: Interceptor = (next) => async (req) => {
  try {
    return await next(req);
  } catch (err) {
    if (err instanceof ConnectError) throw err;
    const method = (req as { method?: { name?: string } }).method?.name ?? 'unknown';
    logger.error(
      { err: (err as Error).message, stack: (err as Error).stack, method },
      'BrowserSessionsService handler error',
    );
    throw new ConnectError(`${method} failed: ${(err as Error).message}`, Code.Internal);
  }
};

// Async because last_screenshot_signed_url is re-minted on every read from the
// GCS object_path stashed in vendor_metadata. The signed URL has a 10 min TTL
// that may have lapsed since the screenshot was captured (sessions can sit
// idle for tens of minutes before being re-read), so caching the URL on the
// row would just push staleness to the client. Signing is local for v4 +
// service-account credentials and a single SignBlob RPC for ADC on Cloud Run
// — acceptable for the dashboard flow. If a list endpoint with many sessions
// becomes hot, batch-sign or cache here. Tests can pass a stub signer via
// the optional override param.
async function toProto(
  s: BrowserSession,
  sign: (objectPath: string) => Promise<{ url: string; expiresAt: Date }> = signObjectPath,
): Promise<ProtoBrowserSession> {
  let lastScreenshotSignedUrl = '';
  let lastScreenshotAt: Timestamp | undefined;
  if (s.lastScreenshotObjectPath && s.lastScreenshotAt) {
    try {
      const signed = await sign(s.lastScreenshotObjectPath);
      lastScreenshotSignedUrl = signed.url;
      lastScreenshotAt = dateToTimestamp(s.lastScreenshotAt);
    } catch (err) {
      // Don't fail the whole RPC response over a signing hiccup — a missing
      // screenshot URL just degrades the paused-frame UX to "no frame", which
      // the frontend already handles. Log loud so the issue is observable.
      logger.warn(
        { vendorSessionId: s.vendorSessionId, err: (err as Error).message },
        'failed to sign last_screenshot_object_path',
      );
    }
  }
  // The open request for the person to take over, when one is pending. The
  // reason is model-only on the wire: the control plane keeps it off the
  // pane's JSON.
  let intervention: ReturnType<typeof create<typeof PendingInterventionSchema>> | undefined;
  if (!s.closedAt) {
    try {
      const { pendingIntervention } = await import('./interventions');
      const pending = await pendingIntervention(s.tenantId, s.id);
      if (pending) {
        intervention = create(PendingInterventionSchema, {
          id: pending.id,
          reason: pending.reason,
          requestedAt: dateToTimestamp(pending.requestedAt),
          requestedByInvocationId: pending.requestedByInvocationId ?? '',
        });
      }
    } catch (err) {
      logger.warn({ session_id: s.id, err: (err as Error).message }, 'the pending intervention could not be read for the session');
    }
  }
  return create(BrowserSessionSchema, {
    id: s.id,
    tenantId: s.tenantId,
    agentId: s.agentId,
    threadId: s.threadId ?? '',
    vendor: s.vendor,
    vendorSessionId: s.vendorSessionId,
    liveViewUrl: s.liveViewUrl ?? '',
    createdAt: dateToTimestamp(s.createdAt),
    lastUsedAt: s.lastUsedAt ? dateToTimestamp(s.lastUsedAt) : undefined,
    expiresAt: s.expiresAt ? dateToTimestamp(s.expiresAt) : undefined,
    closedAt: s.closedAt ? dateToTimestamp(s.closedAt) : undefined,
    takeoverState: s.takeoverState,
    takenOverAt: s.takenOverAt ? dateToTimestamp(s.takenOverAt) : undefined,
    ownerAccountId: s.ownerAccountId ?? '',  // proto field 14, defaults to empty string
    currentUrl: s.currentUrl ?? '',          // proto field 15
    closedReason: s.closedReason ?? '',
    lastScreenshotSignedUrl,
    lastScreenshotAt,
    intervention,
    // When the address was read and the title read beside it, so a reader
    // orders the page line against the record by the read's own time.
    currentUrlAt: s.currentUrlAt ? dateToTimestamp(s.currentUrlAt) : undefined,
    currentTitle: s.currentTitle ?? '',
  });
}

/** The pane viewport's bounds, the same the client clamps to. */
export const VIEWPORT_MIN = { width: 640, height: 480 } as const;
export const VIEWPORT_MAX = { width: 1920, height: 1200 } as const;

/** The width a page is laid out at, whatever the pane measures.
 *
 *  The pane is a side panel a few hundred CSS pixels wide and its live view
 *  scales the page into that box, so a viewport set to the pane's own pixels
 *  lays every site out at a phone or tablet width: columns collapse, menus
 *  fold into a hamburger, wide tables go. What the viewport follows is the
 *  pane's SHAPE, so the live view fills it and a point needs no letterbox;
 *  its SIZE is a desktop's. `paneToViewport` maps a point for any viewport,
 *  so the shape is a convenience and never a correctness condition. */
export const VIEWPORT_LAYOUT_WIDTH = PANE_DIMENSIONS.width;

/** A viewport request: the pane's shape at a desktop's width, clamped and
 *  rounded to 2; null when the request carried none. A pane already at least
 *  that wide is taken as it is. */
export function clampViewport(v: { width?: number; height?: number } | undefined | null): { width: number; height: number } | null {
  if (!v || !v.width || !v.height) return null;
  const scale = v.width > 0 ? Math.max(1, VIEWPORT_LAYOUT_WIDTH / v.width) : 1;
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n / 2) * 2));
  return {
    width: clamp(v.width * scale, VIEWPORT_MIN.width, VIEWPORT_MAX.width),
    height: clamp(v.height * scale, VIEWPORT_MIN.height, VIEWPORT_MAX.height),
  };
}

/** What a fresh session gets after its row is written, fire-and-forget under
 *  one budget: the pane's viewport applied (every vendor, since only Steel
 *  takes it on the create), and the recorder attached for the session's
 *  lifetime, so the first `/pause` takes the fast path. Neither blocks the
 *  response; the session is usable regardless. */
function afterSpawn(tenantId: string, session: BrowserSession, viewport: { width: number; height: number } | null): void {
  void (async () => {
    if (viewport) {
      try {
        await withPage(session.vendor, session.vendorSessionId, tenantId, (page) => page.setViewportSize(viewport), 'setViewport');
        await repo.setViewport(session.id, viewport);
      } catch (err) {
        logger.warn({ session_id: session.id, err: (err as Error).message }, 'the pane viewport could not be applied to the new session');
      }
    }
    try {
      const { warmSessionCapture } = await import('./takeover-capture/session-capture');
      await warmSessionCapture({ tenantId, session });
    } catch (err) {
      logger.warn({ session_id: session.id, err: (err as Error).message }, 'the session capture could not be warmed');
    }
  })();
}

/** The ListTakeoverActivity page cursor: `(started_at, id)` of the last hold
 *  on the page, base64 so the caller treats it as opaque. Keyed on the pair
 *  rather than the timestamp alone so two holds started in the same instant
 *  cannot be skipped between pages. */
function encodeHoldCursor(c: HoldCursor): string {
  return Buffer.from(`${c.startedAt.toISOString()}|${c.id}`, 'utf8').toString('base64url');
}

function decodeHoldCursor(raw: string): HoldCursor | undefined {
  if (!raw) return undefined;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = text.indexOf('|');
  const startedAt = sep > 0 ? new Date(text.slice(0, sep)) : new Date(NaN);
  const id = sep > 0 ? text.slice(sep + 1) : '';
  if (Number.isNaN(startedAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new ConnectError('before_cursor is not a cursor this service issued', Code.InvalidArgument);
  }
  return { startedAt, id };
}

/** Holds per ListTakeoverActivity page, at most. */
const TAKEOVER_ACTIVITY_PAGE_MAX = 5;

/** Rows per ListBrowserActivity page, at most. */
const BROWSER_ACTIVITY_PAGE_MAX = 50;

/** The ListBrowserActivity cursor: `(created_at, id)` of the last row on the
 *  page, base64 so the caller treats it as opaque. */
function encodeActivityCursor(c: ActivityCursor): string {
  return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`, 'utf8').toString('base64url');
}

function decodeActivityCursor(raw: string): ActivityCursor | undefined {
  if (!raw) return undefined;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = text.indexOf('|');
  const createdAt = sep > 0 ? new Date(text.slice(0, sep)) : new Date(NaN);
  const id = sep > 0 ? text.slice(sep + 1) : '';
  if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new ConnectError('before_cursor is not a cursor this service issued', Code.InvalidArgument);
  }
  return { createdAt, id };
}

// protobuf-es v2 strips the enum's name prefix when generating TS values, so
// proto value TYPE_SESSION_CREATED becomes the TS member SESSION_CREATED.
function eventTypeToProto(t: BrowserSessionEvent['type']): StreamSessionEventsResponse_Type {
  switch (t) {
    case 'SESSION_CREATED': return StreamSessionEventsResponse_Type.SESSION_CREATED;
    case 'SESSION_UPDATED': return StreamSessionEventsResponse_Type.SESSION_UPDATED;
    case 'SESSION_CLOSED': return StreamSessionEventsResponse_Type.SESSION_CLOSED;
  }
}

export default function registerBrowserSessionsService(router: ConnectRouter): void {
  router.service(BrowserSessionsService, {
    async listSessionsForThread(req: ListSessionsForThreadRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const sessions = await repo.listForThread(tenantId, req.threadId, {
        includeClosed: req.includeClosed ?? false,
      });
      return create(ListSessionsForThreadResponseSchema, {
        sessions: await Promise.all(sessions.map((s) => toProto(s))),
      });
    },

    async getActiveSessionForThread(req: GetActiveSessionForThreadRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      // Always return success. The old NOT_FOUND contract meant the frontend
      // could never get last_closed_session in the "session timed out" case,
      // which is the entire reason last_closed_session exists. New contract:
      // both fields are optional. Frontend null-checks `session`.
      const [active, lastClosed] = await Promise.all([
        repo.getActiveForThread(tenantId, req.threadId),
        repo.getMostRecentClosedForThread(tenantId, req.threadId),
      ]);
      return create(GetActiveSessionForThreadResponseSchema, {
        session: active ? await toProto(active) : undefined,
        // Only carry the closed session when there is no active one. Otherwise
        // the frontend would have two sessions to choose from and our
        // pausedFrame derivation would be ambiguous. Active wins.
        lastClosedSession: !active && lastClosed ? await toProto(lastClosed) : undefined,
      });
    },

    async createSessionForThread(req: CreateSessionForThreadRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      // Legacy back-compat RPC: no authenticated owner is plumbed here, so the
      // session is created with a NULL owner and an ephemeral (non-persisted)
      // profile. The new pane flow uses EnsureSessionForThread instead.
      const session = await vendorOps.createSessionForThread({
        tenantId,
        agentId: req.agentId,
        threadId: req.threadId,
      });
      afterSpawn(tenantId, session, null);
      return create(CreateSessionForThreadResponseSchema, { session: await toProto(session) });
    },

    async pauseSession(req: PauseSessionRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await repo.getById(req.sessionId);
      if (!session || session.tenantId !== tenantId) {
        throw new ConnectError('session not found', Code.NotFound);
      }
      // Pause Anchor's in-session agent (no-op if no web_task in flight) AND
      // mark our own takeover state so OUR agent loop won't issue another
      // web tool call on this session until released.
      //
      // Re-issued on an already-paused session, this is a lease renewal: the
      // control plane calls it on each poll from the driver to prove they are
      // still at the keyboard, because the takeover gate expires a hold whose
      // taken_over_at goes stale. Anchor's agent is already paused in that
      // case, so calling pauseAgent again would be a vendor round-trip every
      // 90s for no effect — skip it and just restamp.
      const pausedVendor = session.takeoverState !== 'taken_over';
      if (pausedVendor) {
        await vendorOps.pauseAgent(session.vendor, session.vendorSessionId, tenantId);
      }
      // The state transition and the takeover hold, in one transaction. If
      // the vendor's agent was paused just now and this fails, resume it on a
      // best-effort basis and surface the failure rather than leaving its
      // agent paused with no takeover state to say why.
      let started: Awaited<ReturnType<typeof repo.startTakeover>>;
      try {
        started = await repo.startTakeover(req.sessionId);
      } catch (err) {
        if (pausedVendor) {
          try {
            await vendorOps.resumeAgent(session.vendor, session.vendorSessionId, tenantId);
          } catch (e) {
            logger.warn({ sessionId: session.id, err: (e as Error).message }, 'vendor resume after a failed takeover start failed');
          }
        }
        throw err;
      }
      if (!started) {
        // Closed between the read and the write: nothing to hold.
        return create(PauseSessionResponseSchema, { session: await toProto(session) });
      }
      emitBrowserSessionEvent({
        type: 'SESSION_UPDATED', session: started.session, emittedAt: new Date(),
      });
      // Recording is best-effort and bounded, and it happens BEFORE the
      // response: the pane stays non-interactive until this returns, so a
      // recorder attached here has seen every action from the first. A
      // failure or timeout marks the hold incomplete and the takeover still
      // succeeds — a person taking control is never blocked on a recorder.
      await ensureTakeoverCapture({ tenantId, hold: started.hold, session: started.session });
      return create(PauseSessionResponseSchema, { session: await toProto(started.session) });
    },

    async resumeSession(req: ResumeSessionRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await repo.getById(req.sessionId);
      if (!session || session.tenantId !== tenantId) {
        throw new ConnectError('session not found', Code.NotFound);
      }
      // Why the hold ends. Empty is the default a caller that never sends one
      // gets; the control plane's stale-driver sweep names absent_driver.
      let reason: 'released' | 'absent_driver';
      switch (req.endReason) {
        case '': case 'released': reason = 'released'; break;
        case 'absent_driver': reason = 'absent_driver'; break;
        default:
          throw new ConnectError(`end_reason '${req.endReason}' is not one this service records`, Code.InvalidArgument);
      }
      await vendorOps.resumeAgent(session.vendor, session.vendorSessionId, tenantId);
      const ended = await repo.endTakeover(req.sessionId, reason);
      if (ended) emitBrowserSessionEvent({
        type: 'SESSION_UPDATED', session: ended.session, emittedAt: new Date(),
      });
      // The hold this release ended, so the control plane can hand the
      // person's hand-back into the conversation and the runtime can verify
      // that claim against its own record.
      return create(ResumeSessionResponseSchema, {
        session: await toProto(ended?.session ?? session),
        holdId: ended?.holdId ?? '',
      });
    },

    async ensureSessionForThread(
      req: EnsureSessionForThreadRequest,
      _ctx: HandlerContext,
    ) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      if (!req.ownerAccountId) throw new ConnectError('owner_account_id required', Code.InvalidArgument);
      const viewport = clampViewport(req.viewport);
      const existing = await repo.getActiveForThread(tenantId, req.threadId);
      if (existing) {
        return create(EnsureSessionForThreadResponseSchema, {
          session: await toProto(existing),
          wasNewlyCreated: false,
        });
      }
      try {
        const created = await vendorOps.createSessionForThread({
          tenantId,
          agentId: req.agentId,
          // Empty for a team agent; the caller sends it only when a platform
          // assistant opened the pane.
          ...(req.assistant ? { assistant: req.assistant } : {}),
          threadId: req.threadId,
          ownerAccountId: req.ownerAccountId,
          // Steel takes the pane's size on the create; every vendor gets it
          // applied after the row is written (afterSpawn).
          ...(viewport ? { viewport } : {}),
          // 10 minutes matches the web_task autonomous-path setting (see
          // AnchorClient.ensureSession at anchor-client.ts:312). 5 minutes
          // was too aggressive for the interactive pane — when a user
          // switches conversation threads, glances at a notification, or
          // walks away for a few minutes and comes back, a 5-min reap forces
          // a fresh 3-10s Anchor cold-start every time, which reads as
          // sluggishness. 10 min covers the realistic "I'll be right back"
          // window without changing cost characteristics much (Anchor bills
          // per-session-hour; idle minutes that don't get used are essentially
          // free vs. paying for the cold-start re-create).
          idleTimeoutMinutes: 10,
        });
        afterSpawn(tenantId, created, viewport);
        return create(EnsureSessionForThreadResponseSchema, {
          session: await toProto(created),
          wasNewlyCreated: true,
        });
      } catch (err) {
        // Race: another caller inserted between our SELECT and INSERT. The
        // partial unique index rejects ours; re-SELECT and return that.
        if (isPgUniqueViolation(err)) {
          const recovered = await repo.getActiveForThread(tenantId, req.threadId);
          if (recovered) {
            return create(EnsureSessionForThreadResponseSchema, {
              session: await toProto(recovered),
              wasNewlyCreated: false,
            });
          }
        }
        // Classify the failure into a typed envelope when possible. The
        // envelope carries last_closed_session so the frontend can still render
        // the paused-frame UX even though the ensure attempt itself failed.
        // Unclassified errors (DB, code bugs) keep flowing through the
        // interceptor as ConnectError.Internal — they're operator problems, not
        // user-facing copy branches.
        const classified = classifyEnsureError(err);
        if (classified) {
          const lastClosed = await repo.getMostRecentClosedForThread(tenantId, req.threadId);
          logger.warn(
            {
              tenantId,
              threadId: req.threadId,
              kind: classified.kind,
              err: classified.message,
            },
            'ensureSessionForThread classified failure',
          );
          return create(EnsureSessionForThreadResponseSchema, {
            error: create(EnsureSessionErrorSchema, {
              kind: classified.kind,
              message: classified.message,
            }),
            lastClosedSession: lastClosed ? await toProto(lastClosed) : undefined,
          });
        }
        throw err;
      }
    },

    async endSession(
      req: EndSessionRequest,
      _ctx: HandlerContext,
    ) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      if (!req.callerAccountId) throw new ConnectError('caller_account_id required', Code.InvalidArgument);
      const session = await repo.getById(req.sessionId);
      if (!session || session.tenantId !== tenantId) {
        throw new ConnectError('session not found', Code.NotFound);
      }
      // Owner-only enforcement — Y cannot end X's session.
      if (session.ownerAccountId !== req.callerAccountId) {
        throw new ConnectError('only the session owner can end this session', Code.PermissionDenied);
      }
      // The hold ends BEFORE the browser is stopped, so the capture owner's
      // disconnect finds it ended and records no gap; the row still closes
      // vendor-first, which keeps closed_reason honest about settlement.
      await repo.endTakeoverHoldForClose(session.id);
      // The pooled connection, and the recorder attached on it, go before
      // the vendor is told: the disconnect is then ours, not an observation
      // lost.
      await dropConnection(session.vendor, session.vendorSessionId).catch(() => undefined);
      await vendorOps.closeSession(session.vendor, session.vendorSessionId, tenantId);
      const closed = await repo.closeSession(session.id, 'user_ended');
      if (closed) emitBrowserSessionEvent({ type: 'SESSION_CLOSED', session: closed, emittedAt: new Date() });
      return create(EndSessionResponseSchema, { session: await toProto(closed ?? session) });
    },

    /** A navigation, through the ONE helper the team's tool uses too. A
     *  failure before session resolution (NotFound, InvalidArgument) records
     *  nothing; a failure after it is recorded under the caller's id before
     *  the error is thrown, so the ConnectError and the row agree. */
    async goto(req: GotoRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await repo.getById(req.sessionId);
      if (!session || session.tenantId !== tenantId) throw new ConnectError('session not found', Code.NotFound);
      let parsed: URL;
      try {
        parsed = new URL(req.url);
      } catch {
        throw new ConnectError('url must be an absolute http(s) URL', Code.InvalidArgument);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ConnectError('url must be an absolute http(s) URL', Code.InvalidArgument);
      }
      // A pending request for the person to take over gates every mutation,
      // this one included: the caller reads the request's sentence as a
      // FailedPrecondition and gives it to the model as written.
      const pending = await pendingIntervention(tenantId, session.id);
      if (pending) throw new ConnectError(interventionGateMessage(pending.reason), Code.FailedPrecondition);
      const nav = await navigateAndRecord({
        tenantId, session, url: parsed.toString(),
        ...(req.activityId ? { activityId: req.activityId } : {}),
      });
      return create(GotoResponseSchema, {
        session: await toProto(nav.session ?? session),
        finalUrl: nav.finalUrl,
        title: nav.title,
        // The echo is a receipt: nonempty says the row was written.
        activityId: nav.activityId ?? '',
        finalUrlProtectedDataOmitted: nav.finalUrlProtectedDataOmitted,
        finalUrlTruncated: nav.finalUrlTruncated,
        titleTruncated: nav.titleTruncated,
        titleProtectedDataOmitted: nav.titleProtectedDataOmitted,
      });
    },

    /** The live pane URL and a screenshot. `url` is the raw live URL for the
     *  active pane only; `recorded_url` is the safe projection assistant
     *  code uses. A read is recorded as work ONLY when the caller says so
     *  (`record_activity`): pane polling creates no activity row. */
    async getPageState(req: GetPageStateRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await repo.getById(req.sessionId);
      if (!session || session.tenantId !== tenantId) throw new ConnectError('session not found', Code.NotFound);
      // The URL and title are the read; the screenshot rides along for the
      // pane and is best-effort. After a person hands the browser back, the
      // vendor's page can have a zero-width viewport for a moment and the
      // screenshot throws, which must not take the whole read down with it
      // and leave the assistant saying it could not see the browser.
      // `full_page` stitches the whole scrollable height through the vendor's
      // own capture; without it the frame is what is in view. A vendor that
      // cannot stitch falls back to the viewport frame rather than failing the
      // read, for the same reason the screenshot is best-effort at all: a
      // smaller picture answers most of the question and no picture answers
      // none of it.
      const screenshot = req.fullPage
        ? vendorOps.fetchToolsScreenshot(session.vendor, session.vendorSessionId, tenantId, { captureFullHeight: true })
          .catch((err: Error) => {
            logger.warn({ vendor: session.vendor, vendor_session_id: session.vendorSessionId, err: err.message },
              'getPageState: the whole page could not be captured; falling back to the viewport frame');
            return vendorOps.fetchScreenshotPng(session.vendor, session.vendorSessionId, tenantId);
          })
        : vendorOps.fetchScreenshotPng(session.vendor, session.vendorSessionId, tenantId);
      const [page, shot] = await Promise.all([
        vendorOps.getActivePage(session.vendor, session.vendorSessionId, tenantId),
        screenshot
          .then((png) => uploadScreenshotAndSign({ tenantId, vendorSessionId: session.vendorSessionId, png }))
          .catch((err: Error) => {
            logger.warn({ vendor: session.vendor, vendor_session_id: session.vendorSessionId, err: err.message },
              'getPageState: the screenshot could not be taken; answering the URL and title without one');
            return null;
          }),
      ]);
      // Capture the live URL we just read (+ emit SESSION_UPDATED for the pane).
      await persistCurrentUrl(session.vendorSessionId, page.url, page.title ?? null);
      const safeUrl = recordedUrl(page.url ?? '');
      const safeTitle = sanitizeBrowserText(page.title ?? '', PAGE_TITLE_CAP);
      let activityId = '';
      // A pane session always has a thread; a run-scoped one is not pane
      // work and records nothing.
      if (req.recordActivity && session.threadId) {
        const recorded = await recordBrowserActivity({
          id: req.activityId || randomUUID(),
          tenantId,
          threadId: session.threadId,
          sessionId: session.id,
          tool: 'read_active_browser_session',
          instruction: 'read the active page',
          outcome: `read ${safeUrl.text}${safeTitle.text ? `; title: ${safeTitle.text}` : ''}`,
          outcomeTruncated: safeUrl.truncated || safeTitle.truncated,
          outcomeProtectedDataOmitted: safeUrl.protectedDataOmitted || safeTitle.protectedDataOmitted,
          personTookOver: false,
          steps: null,
          captureGap: false,
          gapReason: null,
          stepsTruncated: false,
        });
        activityId = recorded ?? '';
      }
      return create(GetPageStateResponseSchema, {
        url: page.url ?? '',
        screenshotSignedUrl: shot?.url ?? '',
        ...(shot ? { signedUrlExpiresAt: dateToTimestamp(shot.expiresAt) } : {}),
        activityId,
        recordedUrl: safeUrl.text,
        recordedUrlProtectedDataOmitted: safeUrl.protectedDataOmitted,
        recordedTitle: safeTitle.text,
        recordedUrlTruncated: safeUrl.truncated,
        recordedTitleTruncated: safeTitle.truncated,
        recordedTitleProtectedDataOmitted: safeTitle.protectedDataOmitted,
      });
    },

    /** Agentic browsing for a caller that has no tool context.
     *
     *  The platform assistants — Liftoff, the Insights Manager, the Chief AI
     *  Officer — run in other services and cannot reach the runtime's
     *  `run_browser_task` tool, so without this they have no browser at all.
     *
     *  Delegates to runBrowserTaskCore, which is the SAME function the tool
     *  calls. Re-implementing the flow here is what would let the two drift,
     *  and the thing that drifts first is a guard: the takeover gate lives
     *  inside that core so a person at the keyboard stops a platform assistant
     *  exactly as they stop an agent.
     *
     *  Imported dynamically because standard-tool-handler imports this module's
     *  siblings at load time; the codebase already resolves that cycle this way
     *  in the other direction.
     *
     *  An empty agent_id is expected rather than exceptional — a platform
     *  assistant has no agent row — and the core turns it into the no-agent
     *  sentinel the session column requires. */
    async runBrowserTask(req: RunBrowserTaskRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const { runBrowserTaskCore } = await import('../tools/standard-tool-handler');
      const outcome = await runBrowserTaskCore({
        tenantId,
        threadId: req.threadId,
        prompt: req.prompt,
        ownerAccountId: req.ownerAccountId || undefined,
        agentId: req.agentId || undefined,
        assistant: req.assistant || undefined,
        activityId: req.activityId || undefined,
        ...(req.success ? { success: req.success } : {}),
        ...(req.constraints?.length ? { constraints: [...req.constraints] } : {}),
        // Only a caller that says it can come back is handed a task that is
        // still running; everyone else waits, as they always did.
        ...(req.canCollect ? { canCollect: true } : {}),
      });
      return create(RunBrowserTaskResponseSchema, {
        success: outcome.success,
        error: outcome.error ?? '',
        // The vendor's result after its protected-data pass. Encoded here
        // rather than shaped, because the caller feeds it to a model.
        resultJson: outcome.result === undefined
          ? new Uint8Array()
          : new TextEncoder().encode(JSON.stringify(outcome.result)),
        // The loop's steps, from the core's SEPARATE typed field and never
        // parsed out of the result, with the completeness fields that say
        // when observation was partial. Presence is the signal.
        ...(outcome.trail
          ? {
            trail: create(BrowserTaskTrailSchema, {
              message: outcome.trail.message,
              steps: outcome.trail.steps.map((step) => create(BrowserTaskStepSchema, {
                type: step.type,
                action: step.action,
                pageUrl: step.pageUrl,
                actionTruncated: step.actionTruncated,
                pageUrlTruncated: step.pageUrlTruncated,
                protectedDataOmitted: step.protectedDataOmitted,
                protectedKind: step.protectedKind,
                pageUrlProtectedDataOmitted: step.pageUrlProtectedDataOmitted,
                ...(step.at ? { at: dateToTimestamp(step.at) } : {}),
              })),
              captureGap: outcome.trail.captureGap,
              gapReason: outcome.trail.gapReason ?? '',
              stepsTruncated: outcome.trail.stepsTruncated,
            }),
          }
          : {}),
        ...(outcome.session ? { session: await toProto(outcome.session) } : {}),
        // The echo is a receipt: nonempty says the runtime wrote the row.
activityId: outcome.activityId ?? '',
        // Set when the task outlived the call: the caller collects it with
        // CheckBrowserTask rather than being told nothing happened.
        carryingOnTaskId: outcome.carryingOnTaskId ?? '',
      });
    },

    /** Every recorded pane work call on a thread, newest first, whoever
     *  made it. `has_steps` is presence: a browser task carries an array
     *  (empty when the loop took no step); a navigation or a read carries
     *  none. A row whose stored steps no longer match the bounded schema is
     *  answered with an empty list and a reconciliation gap, never with
     *  attacker-shaped fields. */
    async listBrowserActivity(req: ListBrowserActivityRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      if (!req.threadId) throw new ConnectError('thread_id required', Code.InvalidArgument);
      // Clamped to [1, 50]: an unset limit (proto3's 0) reads as 1.
      const limit = Math.min(BROWSER_ACTIVITY_PAGE_MAX, Math.max(1, req.limit));
      const before = decodeActivityCursor(req.beforeCursor);
      const { rows, hasMore } = await listBrowserActivity(tenantId, req.threadId, { limit, before });
      const last = rows[rows.length - 1];
      return create(ListBrowserActivityResponseSchema, {
        rows: rows.map(activityRowToProto),
        nextCursor: hasMore && last ? encodeActivityCursor({ createdAt: last.createdAt, id: last.id }) : '',
      });
    },

    /** The person's own takeover segments on a thread, newest first, with
     *  what they did in each. `live` is computed here from the joined session
     *  row; a hold with no end that is not live is an orphan and is reported
     *  as such rather than given an end it never recorded. */
    async listTakeoverActivity(req: ListTakeoverActivityRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      if (!req.threadId) throw new ConnectError('thread_id required', Code.InvalidArgument);
      // Clamped to [1, 5]: an unset limit (proto3's 0) reads as 1, so a
      // caller that wants a page names it.
      const limit = Math.min(TAKEOVER_ACTIVITY_PAGE_MAX, Math.max(1, req.limit));
      const before = decodeHoldCursor(req.beforeCursor);
      // Exactly one hold when the caller names it: a claim about a hand-back
      // or a point is verified against this read. A malformed id matches
      // nothing rather than throwing.
      const holdId = req.holdId && /^[0-9a-f-]{36}$/i.test(req.holdId) ? req.holdId : undefined;
      if (req.holdId && !holdId) return create(ListTakeoverActivityResponseSchema, { holds: [], nextCursor: '' });
      const newestActions = req.newestActions > 0 ? req.newestActions : undefined;
      const { holds, hasMore } = await listTakeoverHolds(tenantId, req.threadId, { limit, before, holdId, newestActions });
      const last = holds[holds.length - 1];
      // The request each hold answered, when one did, so the record can say
      // "you asked the person to: ...". One hold named is one read.
      const interventions = await (holdId && holds.length === 1
        ? interventionForHold(tenantId, holdId).then((one) => new Map(one ? [[holdId, one]] : []))
        : interventionsForHolds(tenantId, holds.map((h) => h.id))
      ).catch((err: Error) => {
        logger.warn({ err: err.message }, 'listTakeoverActivity: interventions could not be read');
        return new Map<string, never>();
      });
      // An open hold on a session that is closed or no longer taken over
      // was ended by something that bypassed the hold (an older instance
      // during rollout, a raw state change). Its end is the session's
      // close when there is one and unknown otherwise, and part of it was
      // not observed; nothing is fabricated from its last action. That
      // reading lives in activity-wire.ts, with the Browser block's.
      return create(ListTakeoverActivityResponseSchema, {
        holds: holds.map((hold) => holdToProto(hold, interventions.get(hold.id) ?? null)),
        nextCursor: hasMore && last ? encodeHoldCursor({ startedAt: last.startedAt, id: last.id }) : '',
      });
    },

    /** The page's controls, read and classified in the recorder's world
     *  (pane-actions.ts). Recorded as work only when the caller says so. */
    async snapshotPage(req: SnapshotPageRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await sessionForThread(tenantId, req.sessionId, req.threadId);
      let snapshot;
      try {
        snapshot = await snapshotPage(session, tenantId, {
          includeText: req.includeText,
          recordActivity: req.recordActivity,
          ...(req.activityId ? { activityId: req.activityId } : {}),
          startAt: req.startAt,
        });
      } catch (err) {
        if (err instanceof PaneUnavailable) throw new ConnectError(err.message, Code.Unavailable);
        throw err;
      }
      return create(SnapshotPageResponseSchema, {
        snapshotId: snapshot.id,
        recordedUrl: snapshot.url.text,
        recordedUrlTruncated: snapshot.url.truncated,
        recordedUrlProtectedDataOmitted: snapshot.url.protectedDataOmitted,
        recordedTitle: snapshot.title.text,
        recordedTitleTruncated: snapshot.title.truncated,
        recordedTitleProtectedDataOmitted: snapshot.title.protectedDataOmitted,
        controls: snapshot.controls.map((c) => create(PageControlSchema, c)),
        controlsTruncated: snapshot.controlsTruncated,
        framesNotListed: snapshot.framesNotListed,
        text: snapshot.text?.text ?? '',
        textTruncated: snapshot.text?.truncated ?? false,
        textProtectedDataOmitted: snapshot.text?.protectedDataOmitted ?? false,
        activityId: snapshot.activityId ?? '',
        total: snapshot.total,
      });
    },

    /** One action on one control, through the same module and the same
     *  gates the team's tool uses. */
    async actOnPage(req: ActOnPageRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await sessionForThread(tenantId, req.sessionId, req.threadId);
      if (!(PANE_ACTION_KINDS as readonly string[]).includes(req.action)) {
        throw new ConnectError(`action must be one of ${PANE_ACTION_KINDS.join(', ')}`, Code.InvalidArgument);
      }
      const action: PaneAction = {
        action: req.action as PaneAction['action'],
        // The reference overrides the words: a caller that holds one is taken
        // at its word and nothing is resolved.
        ...(req.ref ? { ref: req.ref } : {}),
        ...(req.what ? { what: req.what } : {}),
        ...(req.text ? { text: req.text } : {}),
        ...(req.submit ? { submit: true } : {}),
        ...(req.value ? { value: req.value } : {}),
        ...(req.key ? { key: req.key } : {}),
        ...(req.direction === 'up' || req.direction === 'down' ? { direction: req.direction } : {}),
        ...(req.amount ? { amount: req.amount } : {}),
      };
      let outcome;
      try {
        outcome = await actOnPage(session, tenantId, req.snapshotId, action, req.activityId || undefined);
      } catch (err) {
        if (err instanceof PaneUnavailable) throw new ConnectError(err.message, Code.Unavailable);
        throw err;
      }
      // A pending request for the person to take over gates every mutation
      // the same way: the caller reads the request's sentence as a
      // FailedPrecondition, as Goto answers it. The refusal is recorded.
      if (outcome.refusalKind === 'intervention_pending') {
        throw new ConnectError(outcome.message, Code.FailedPrecondition);
      }
      return create(ActOnPageResponseSchema, {
        acted: outcome.acted,
        refusalKind: outcome.refusalKind,
        coveredBy: outcome.coveredBy,
        personTookOverDuring: outcome.personTookOverDuring,
        recordedUrl: outcome.url.text,
        recordedUrlTruncated: outcome.url.truncated,
        recordedUrlProtectedDataOmitted: outcome.url.protectedDataOmitted,
        recordedTitle: outcome.title.text,
        recordedTitleTruncated: outcome.title.truncated,
        recordedTitleProtectedDataOmitted: outcome.title.protectedDataOmitted,
        activityId: outcome.activityId ?? '',
        message: outcome.message,
      });
    },

    /** Ask the person to take over, or withdraw the ask. */
    async requestIntervention(req: RequestInterventionRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await sessionForThread(tenantId, req.sessionId, req.threadId);
      if (req.withdraw) {
        const ended = await endInterventions(undefined, session.id, 'cancelled', tenantId);
        const after = (await repo.getById(session.id)) ?? session;
        if (ended > 0) emitBrowserSessionEvent({ type: 'SESSION_UPDATED', session: after, emittedAt: new Date() });
        return create(RequestInterventionResponseSchema, {
          session: await toProto(after),
          interventionId: '',
          alreadyPending: false,
          withdrawn: ended > 0,
        });
      }
      if (!req.reason.trim()) throw new ConnectError('reason required', Code.InvalidArgument);
      const { intervention, alreadyPending } = await requestIntervention({
        tenantId, sessionId: session.id, threadId: session.threadId, reason: req.reason,
        requestedByInvocationId: req.requestedByInvocationId || null,
      });
      const after = (await repo.getById(session.id)) ?? session;
      if (!alreadyPending) emitBrowserSessionEvent({ type: 'SESSION_UPDATED', session: after, emittedAt: new Date() });
      return create(RequestInterventionResponseSchema, {
        session: await toProto(after),
        interventionId: intervention.id,
        alreadyPending,
        withdrawn: false,
      });
    },

    /** The person pointed at something in the live view without taking
     *  over (point-at.ts). */

    /** The pane's size, applied to the page and stored on the row so the
     *  next screenshot restores it instead of the constant. No sequencing,
     *  no lock: the client's debounce and the restore are the net. */
    async setViewport(req: SetViewportRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await sessionForThread(tenantId, req.sessionId, req.threadId);
      const viewport = clampViewport(req.viewport);
      if (!viewport) throw new ConnectError('viewport required', Code.InvalidArgument);
      try {
        await withPage(session.vendor, session.vendorSessionId, tenantId, (page) => page.setViewportSize(viewport), 'setViewport');
      } catch (err) {
        // The pane reports its size as the person drags it, and a session the
        // vendor released in the meantime is the ordinary end of one, not an
        // internal failure: NotFound is what every other read of a session
        // that is gone answers, and it is what tells the pane to open a new
        // one. Answering Internal put a 500 in the logs for a resize.
        if (isVendorSessionGone(err)) throw new ConnectError('session not found', Code.NotFound);
        throw err;
      }
      await repo.setViewport(session.id, viewport);
      return create(SetViewportResponseSchema, { applied: create(ViewportSchema, viewport) });
    },

    /** The result of a task that outlived the call that started it.
     *
     *  Read off the session's row, so the turn that comes back for it finds
     *  it whichever instance answers. Still running reads as `running`,
     *  which is the answer that must not be confused with a task that
     *  finished quietly. */
    async checkBrowserTask(req: CheckBrowserTaskRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await repo.getById(req.sessionId);
      if (!session || session.tenantId !== tenantId) throw new ConnectError('session not found', Code.NotFound);
      const { finishedTask } = await import('../integrations/web-fetch/browser-task');
      const done = await finishedTask(tenantId, session.vendorSessionId, req.taskId);
      if (!done) {
        return create(CheckBrowserTaskResponseSchema, {
          status: 'running',
          message: 'That task is still running in the browser. Tell the person it is still going and that you will '
            + 'come back to them with it — not that they need to message you, because this conversation is woken when '
            + 'the job finishes. Do not start it again: a second one would redo work this one has already done.',
        });
      }
      // What the task PRODUCED, beside what it said. A task sent to generate
      // something ends with the file in the session's downloads, and an
      // assistant only told the task finished has to think to go and look.
      // It rides the message rather than a field of its own, so the three
      // assistants are told what the agents' own tool tells them without
      // the response shape having to change.
      const files = await listDownloadsForSession(tenantId, session).catch(() => []);
      const note = files.length === 0 ? '' : '\n\nThe task left these files in the browser session: '
        + files.map((f) => f.suggestedFileName).filter(Boolean).join(', ')
        + '. Give the person the one they asked for by fetching it and attaching it to your reply; '
        + 'do not describe it instead of delivering it.';
      return create(CheckBrowserTaskResponseSchema, {
        status: done.status,
        message: done.message + note,
        reason: done.reason,
      });
    },

    /** What this session has downloaded. Heard on the session's own browser
     *  connection, so every vendor answers; one vendor's own download store
     *  is merged in. The body is shared with the runtime's own tool, so the
     *  agents and the platform assistants cannot be told different things
     *  about one session. */
    async listSessionDownloads(req: ListSessionDownloadsRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await repo.getById(req.sessionId);
      if (!session || session.tenantId !== tenantId) throw new ConnectError('session not found', Code.NotFound);
      const downloads = await listDownloadsForSession(tenantId, session);
      return create(ListSessionDownloadsResponseSchema, {
        downloads: downloads.map((d) => create(SessionDownloadSchema, {
          id: d.id,
          url: d.url,
          suggestedFileName: d.suggestedFileName,
          originUrl: d.originUrl,
          downloadedAt: dateToTimestamp(new Date(d.downloadedAt)),
        })),
      });
    },

    /** One file out of the session, by download id or by the address the
     *  page points at, fetched from inside the page so the session's own
     *  sign-in applies.
     *
     *  A file that cannot be fetched answers `refusal` rather than throwing:
     *  the reason is the useful thing, and a caller that got an exception
     *  would have to invent a sentence for the person. */
    async fetchSessionFile(req: FetchSessionFileRequest, _ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const session = await repo.getById(req.sessionId);
      if (!session || session.tenantId !== tenantId) throw new ConnectError('session not found', Code.NotFound);
      try {
        const file = await fetchFileForSession(tenantId, session, {
          downloadId: req.downloadId, url: req.url,
        });
        return create(FetchSessionFileResponseSchema, {
          content: new Uint8Array(file.bytes),
          contentType: file.contentType,
          filename: file.filename,
          sourceUrl: file.sourceUrl,
        });
      } catch (err) {
        const name = (err as Error).name;
        if (name === 'FileTooLarge' || name === 'FileNotFetchable') {
          return create(FetchSessionFileResponseSchema, { refusal: (err as Error).message });
        }
        throw err;
      }
    },

    async *streamSessionEvents(req: StreamSessionEventsRequest, ctx: HandlerContext) {
      const tenantId = req.tenantContext?.tenantId ?? '';
      const emitter = getBrowserSessionEmitter();
      const queue: BrowserSessionEvent[] = [];
      let resolveNext: (() => void) | null = null;
      const onEvent = (event: BrowserSessionEvent) => {
        if (event.session.tenantId !== tenantId) return;
        if (req.threadId && event.session.threadId !== req.threadId) return;
        queue.push(event);
        resolveNext?.();
        resolveNext = null;
      };
      emitter.on('event', onEvent);
      ctx.signal.addEventListener('abort', () => {
        emitter.off('event', onEvent);
        resolveNext?.();
      });
      try {
        while (!ctx.signal.aborted) {
          while (queue.length > 0) {
            const event = queue.shift()!;
            yield create(StreamSessionEventsResponseSchema, {
              type: eventTypeToProto(event.type),
              session: await toProto(event.session),
              emittedAt: dateToTimestamp(event.emittedAt),
            });
          }
          if (ctx.signal.aborted) break;
          await new Promise<void>((resolve) => { resolveNext = resolve; });
        }
      } finally {
        emitter.off('event', onEvent);
      }
    },
  });
}
