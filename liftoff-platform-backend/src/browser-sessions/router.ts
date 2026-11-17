// PR3: Dashboard REST surface for Anchor browser sessions. Proxies through to
// tenant-runtime's BrowserSessionsService Connect-RPC handlers. Auth model
// matches insights/router.ts — resolveCaller + getThread ownership check.

import { Router, type Request, type Response } from 'express';
import { assertPublicUrl, BlockedUrlError } from '../common/url-guard';
import { z } from 'zod';
import { getBrowserSessionsServiceClient } from '../connectors/tenant-runtime-service-client';
import { resolveCaller, type CallerContext } from '../auth/resolve-caller';
import { AccountService } from '../accounts/service';
import * as driverRepo from './driver-repository';
// The pane runs on four chat surfaces, each with its threads in its own table;
// thread-surface.ts picks the table from the surface the caller names, and the
// SSE stream router uses the same lookup so the two cannot disagree.
import { findThreadOnSurface, surfaceQuerySchema, type ThreadSurface } from './thread-surface';
import { takeoverActionOut } from './takeover-activity';
import { log as logger } from '../infrastructure/logging';
import { toJson } from '@bufbuild/protobuf';
import { TimestampSchema } from '@bufbuild/protobuf/wkt';
import {
  BrowserSessionSchema,
  EnsureSessionError_Kind,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';
import type {
  BrowserSession,
  EnsureSessionError,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';

export const browserSessionsRouter = Router();

const accountService = new AccountService();

// The Connect client returns protobuf-es MESSAGE objects whose Timestamp fields
// hold `bigint` seconds. Passing those straight to res.json() throws
// "Do not know how to serialize a BigInt". toJson() emits proto-JSON: camelCase
// keys, RFC3339 timestamp strings, BigInt-free — the exact shape the frontend
// BrowserSession type expects. Empty strings / unset timestamps are omitted
// (frontend treats undefined === null), so an empty owner_account_id correctly
// reads as "no owner" (End-session affordance stays hidden for legacy rows).
//
// `owner` is attached on top of the proto-JSON so the pane can show whose
// browser this is. It is deliberately not a proto field: owner_account_id comes
// from tenant-runtime (web_sessions) while accounts live in the control-plane
// DB, so the person cannot be joined in SQL and is resolved here instead. The
// shape matches the frontend's AvatarPerson so UserAvatar consumes it directly.
interface SessionOwnerJson {
  accountId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
}

// Per-request memo: a response can carry several sessions owned by the same
// person (list, or session + lastClosedSession), and one lookup is enough.
type OwnerCache = Map<string, SessionOwnerJson | null>;

async function resolveOwner(
  accountId: string | undefined,
  cache: OwnerCache,
): Promise<SessionOwnerJson | null> {
  if (!accountId) return null;
  const cached = cache.get(accountId);
  if (cached !== undefined) return cached;

  let owner: SessionOwnerJson | null = null;
  try {
    const account = await accountService.getById(accountId);
    if (account) {
      owner = {
        accountId: account.id,
        firstName: account.firstName ?? null,
        lastName: account.lastName ?? null,
        email: account.email,
        avatarUrl: account.avatarUrl ?? null,
      };
    }
  } catch (error) {
    // Never fail a session read because the owner could not be resolved — the
    // pane simply renders without an avatar.
    logger.warn(
      { accountId, error: (error as Error).message },
      'browser session owner lookup failed',
    );
  }
  cache.set(accountId, owner);
  return owner;
}

const sessionJson = async (
  s: BrowserSession | undefined,
  cache: OwnerCache = new Map(),
  tenantId?: string,
  // Pass this when the caller already resolved the driver (the active-session
  // handler does, for its stale sweep) so one read does not query it twice.
  knownDriver?: driverRepo.SessionDriver | null,
  // Where the driver's presence can be read, when the route knows the surface.
  presence?: driverRepo.DriverPresenceSource,
) => {
  if (!s) return null;
  // takeover_state is authoritative for *whether* a human holds control; the
  // driver row only names them. A driver without takeover is stale bookkeeping
  // (a release that raced a read), so it is not surfaced.
  const driver =
    s.takeoverState !== 'taken_over'
      ? null
      : knownDriver !== undefined
        ? knownDriver
        : tenantId
          ? await driverRepo.getDriver(tenantId, s.id, presence)
          : null;
  // toJson is typed as JsonValue; the schema guarantees an object here.
  return {
    ...(toJson(BrowserSessionSchema, s) as Record<string, unknown>),
    owner: await resolveOwner(s.ownerAccountId || undefined, cache),
    driver,
    // The open request for the person to take over: that one is open, and
    // when it was made. Never the reason, which is the model's words and
    // reaches the person through the assistant's own guarded reply.
    intervention: s.intervention?.requestedAt
      ? { requestedAt: toJson(TimestampSchema, s.intervention.requestedAt) }
      : null,
  };
};

// Maps the proto enum to a stable string key the frontend pattern-matches on.
// proto3 enums are int32 on the wire and unstable to expose directly to JSON
// consumers; the string form is the contract we ship to the React app.
function ensureErrorKindToString(kind: EnsureSessionError_Kind): string {
  switch (kind) {
    case EnsureSessionError_Kind.ANCHOR_UNAVAILABLE: return 'anchor_unavailable';
    case EnsureSessionError_Kind.QUOTA_EXCEEDED:     return 'quota_exceeded';
    case EnsureSessionError_Kind.INVALID_KEY:        return 'invalid_key';
    case EnsureSessionError_Kind.UNKNOWN:            return 'unknown';
    // KIND_UNSPECIFIED should never reach here — proto-default-init bug only.
    case EnsureSessionError_Kind.UNSPECIFIED:        return 'unknown';
  }
}

function ensureErrorJson(e: EnsureSessionError | undefined) {
  return e ? { kind: ensureErrorKindToString(e.kind), message: e.message } : null;
}

const threadParamSchema = z.object({ threadId: z.string().uuid() });
const tenantQuerySchema = z.object({ tenantId: z.string().uuid() });

/** The pane's size, as the client measured it: clamped to the same bounds the
 *  runtime applies, and even, so a vendor that halves for device scale gets
 *  whole pixels. Validated here so a body outside the bounds is a 400 rather
 *  than a silently different size. */
const VIEWPORT_MIN = { width: 640, height: 480 };
const VIEWPORT_MAX = { width: 1920, height: 1200 };
const viewportSchema = z.object({
  width: z.number().int().min(VIEWPORT_MIN.width).max(VIEWPORT_MAX.width).refine((n) => n % 2 === 0, 'even'),
  height: z.number().int().min(VIEWPORT_MIN.height).max(VIEWPORT_MAX.height).refine((n) => n % 2 === 0, 'even'),
});

async function authorizeThread(req: Request, res: Response) {
  const params = threadParamSchema.safeParse(req.params);
  const query = tenantQuerySchema.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: 'Validation failed' });
    return null;
  }
  const surfaceParse = surfaceQuerySchema.safeParse(req.query);
  if (!surfaceParse.success) {
    res.status(400).json({ error: 'Validation failed' });
    return null;
  }
  const surface: ThreadSurface = surfaceParse.data.surface ?? 'agent';
  const { tenantId } = query.data;
  // Membership is proved BEFORE the thread is read, on every surface. The
  // surface only chooses the table.
  const resolution = await resolveCaller(req.ctx?.userId, tenantId);
  if (!resolution.ok) {
    res.status(resolution.status).json({ error: resolution.error });
    return null;
  }
  const thread = await findThreadOnSurface(surface, params.data.threadId, tenantId, resolution.caller);
  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return null;
  }
  return { tenantId, thread, surface, caller: resolution.caller };
}

async function authorizeSession(req: Request, res: Response) {
  const sessionId = z.string().uuid().safeParse(req.params.sessionId);
  const query = tenantQuerySchema.safeParse(req.query);
  if (!sessionId.success || !query.success) {
    res.status(400).json({ error: 'Validation failed' });
    return null;
  }
  const resolution = await resolveCaller(req.ctx?.userId, query.data.tenantId);
  if (!resolution.ok) {
    res.status(resolution.status).json({ error: resolution.error });
    return null;
  }
  // Tenant scope is enforced by the underlying RPC — mismatched session →
  // NotFound, so we never leak existence.
  return { tenantId: query.data.tenantId, sessionId: sessionId.data, caller: resolution.caller };
}

browserSessionsRouter.get('/threads/:threadId/browser-sessions', async (req, res) => {
  try {
    const ctx = await authorizeThread(req, res);
    if (!ctx) return;
    const includeClosed = req.query.includeClosed === 'true';
    const client = await getBrowserSessionsServiceClient(ctx.tenantId);
    const { sessions } = await client.listSessionsForThread({
      tenantContext: { tenantId: ctx.tenantId },
      threadId: ctx.thread.id,
      includeClosed,
    });
    const ownerCache: OwnerCache = new Map();
    return res.json({
      sessions: await Promise.all(sessions.map((s) => sessionJson(s, ownerCache))),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'list browser sessions failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});

browserSessionsRouter.get('/threads/:threadId/browser-sessions/active', async (req, res) => {
  const ctx = await authorizeThread(req, res);
  if (!ctx) return;
  try {
    const client = await getBrowserSessionsServiceClient(ctx.tenantId);
    // New contract (PR4 paused-frame UX): RPC ALWAYS returns success. Both
    // session and lastClosedSession are optional. The 404 branch is gone —
    // the frontend null-checks `session` and renders the paused-frame UX off
    // `lastClosedSession` when present and `closed_reason === 'idle_timeout'`
    // with a non-empty `last_screenshot_signed_url`.
    const { session, lastClosedSession } = await client.getActiveSessionForThread({
      tenantContext: { tenantId: ctx.tenantId },
      threadId: ctx.thread.id,
    });
    // Stale-driver sweep. A driver who closed their tab cannot tell us they
    // let go, so control would sit held forever with the agent blocked at tool
    // dispatch. Releasing our row is not enough — takeover_state lives in
    // tenant-runtime, so the agent only unblocks via resumeSession. Done on
    // read because that is the moment somebody is looking and cares.
    let activeDriver: driverRepo.SessionDriver | null | undefined;
    if (session && session.takeoverState === 'taken_over') {
      // Presence is read from THIS surface's heartbeat table; a driver who
      // heartbeats in another table reads as absent from the wrong one.
      const driver = await driverRepo.getDriver(ctx.tenantId, session.id, {
        surface: ctx.surface,
        callerAccountId: ctx.caller.accountId,
        threadId: ctx.thread.id,
      });
      activeDriver = driver;
      // Refresh the hold while the driver is the one asking. tenant-runtime
      // expires a takeover whose taken_over_at goes stale, which is what stops
      // an absent human outranking the agent; this poll is the heartbeat that
      // proves they are still here. pauseSession is idempotent — it re-pauses
      // an already-paused Anchor agent and restamps taken_over_at.
      if (driver && driver.present === true && driver.accountId === ctx.caller.accountId) {
        try {
          await client.pauseSession({
            tenantContext: { tenantId: ctx.tenantId },
            sessionId: session.id,
          });
        } catch (err) {
          logger.warn(
            { sessionId: session.id, err: (err as Error).message },
            'takeover refresh failed',
          );
        }
      }
      // Only a KNOWN absence releases control. Unknown (null) presence, when
      // the surface's presence source could not answer, judges nothing; the
      // runtime's own gate expiry is the net there.
      if (driver && driver.present === false) {
        try {
          await client.resumeSession({
            tenantContext: { tenantId: ctx.tenantId },
            sessionId: session.id,
            // Named so the runtime's record of the hold says the driver went
            // away, not that they gave control back.
            endReason: 'absent_driver',
          });
          await driverRepo.releaseDriver(ctx.tenantId, session.id);
          session.takeoverState = 'none';
          activeDriver = null;
          logger.info(
            { sessionId: session.id, accountId: driver.accountId },
            'released browser control from an absent driver',
          );
        } catch (err) {
          // Never fail the read over a self-heal; the next poll retries.
          logger.warn(
            { sessionId: session.id, err: (err as Error).message },
            'stale driver release failed',
          );
        }
      }
    }

    const ownerCache: OwnerCache = new Map();
    return res.json({
      session: await sessionJson(session, ownerCache, ctx.tenantId, activeDriver),
      lastClosedSession: await sessionJson(lastClosedSession, ownerCache, ctx.tenantId, undefined, {
        surface: ctx.surface, callerAccountId: ctx.caller.accountId,
      }),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'get active browser session failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});

browserSessionsRouter.post('/threads/:threadId/browser-sessions', async (req, res) => {
  const ctx = await authorizeThread(req, res);
  if (!ctx) return;
  const body = z.object({ agentId: z.string().uuid().optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'agentId must be a UUID when present' });
  // Required on AGENT chat and optional nowhere else, because that is exactly
  // where it means something. An agent's session must be spawned against its
  // bindings — a missing agent there would silently hand it the platform
  // browser instead of the vendor it was equipped with. The platform
  // assistants have no agent row to name, and for them the absence is the
  // truth rather than an omission.
  if (ctx.surface === 'agent' && !body.data.agentId) {
    return res.status(400).json({ error: 'agentId required' });
  }
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const { session } = await client.createSessionForThread({
    tenantContext: { tenantId: ctx.tenantId },
    threadId: ctx.thread.id,
    agentId: body.data.agentId ?? '',
    ...(ctx.surface === 'agent' ? {} : { assistant: ctx.surface }),
  });
  return res.status(201).json({ session: await sessionJson(session) });
});

// Pause IS take-control: tenant-runtime pauses Anchor's in-session agent and
// sets takeover_state, which blocks our agent's browser tools at dispatch.
// The only thing it does not record is which human did it, so we do that here.
//
// One person holds the wheel until they hand it back or go absent, which is
// how every shared-control tool behaves. So before the RPC: when another
// account is the recorded driver, their presence is not known to be gone,
// and the runtime still has the session taken over, this answers 409
// `held_by_other` and claims nothing. Without the check, claimDriver's DO
// UPDATE switched the driver record under a hold that continued. The runtime's
// state is read through the thread the client names (`threadId` and `surface`
// beside `tenantId`); an older client that names none is served as before.
browserSessionsRouter.post('/browser-sessions/:sessionId/pause', async (req, res) => {
  const ctx = await authorizeSession(req, res);
  if (!ctx) return;
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const driver = await driverRepo.getDriver(ctx.tenantId, ctx.sessionId, await pausePresenceSource(req, ctx));
  if (driver && driver.accountId !== ctx.caller.accountId && driver.present !== false) {
    const runtime = await runtimeSessionForPause(req, res, ctx);
    if (runtime === undefined) return;
    if (runtime?.takeoverState === 'taken_over') {
      return res.status(409).json({ error: 'held_by_other' });
    }
  }
  const { session } = await client.pauseSession({
    tenantContext: { tenantId: ctx.tenantId },
    sessionId: ctx.sessionId,
  });
  // After the RPC, so a failed takeover never leaves a driver recorded for a
  // session the agent is still driving.
  await driverRepo.claimDriver(ctx.tenantId, ctx.sessionId, ctx.caller.accountId);
  return res.json({ session: await sessionJson(session, new Map(), ctx.tenantId) });
});

// Resume IS release-control: the agent is unblocked and nobody holds the wheel.
// Open to any member, as it always was. The answer names the hold the runtime
// ended and whether the caller was the recorded driver: a client that was
// sends the hand-back into the conversation as a turn, naming the hold, and
// the stream router verifies that claim against the runtime's record.
browserSessionsRouter.post('/browser-sessions/:sessionId/resume', async (req, res) => {
  const ctx = await authorizeSession(req, res);
  if (!ctx) return;
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  // Read BEFORE the RPC: the release below deletes the record.
  const driver = await driverRepo.getDriver(ctx.tenantId, ctx.sessionId);
  const { session, holdId } = await client.resumeSession({
    tenantContext: { tenantId: ctx.tenantId },
    sessionId: ctx.sessionId,
  });
  await driverRepo.releaseDriver(ctx.tenantId, ctx.sessionId);
  const releasedByDriver = holdId !== '' && driver?.accountId === ctx.caller.accountId;
  return res.json({
    session: await sessionJson(session, new Map(), ctx.tenantId),
    holdId: holdId || null,
    releasedByDriver,
  });
});

/** Where the driver's presence can be read on a pause, when the client
 *  names the surface; undefined otherwise, and presence reads as unknown. */
async function pausePresenceSource(
  req: Request,
  ctx: { tenantId: string; caller: { accountId: string } },
): Promise<driverRepo.DriverPresenceSource | undefined> {
  const q = pauseThreadQuerySchema.safeParse(req.query);
  if (!q.success || !q.data.threadId) return undefined;
  return { surface: q.data.surface ?? 'agent', callerAccountId: ctx.caller.accountId, threadId: q.data.threadId };
}

const pauseThreadQuerySchema = z.object({
  threadId: z.string().uuid().optional(),
  surface: surfaceQuerySchema.shape.surface,
});

/** The runtime's session for a pause, read through the thread the client
 *  named and authorized to it: the session must be that thread's active one.
 *  Null when the client named no thread (an older client) or the runtime has
 *  no active session there; undefined when the response was already sent. */
async function runtimeSessionForPause(
  req: Request,
  res: Response,
  ctx: { tenantId: string; sessionId: string; caller: CallerContext },
): Promise<BrowserSession | null | undefined> {
  const q = pauseThreadQuerySchema.safeParse(req.query);
  if (!q.success || !q.data.threadId) return null;
  const surface: ThreadSurface = q.data.surface ?? 'agent';
  const thread = await findThreadOnSurface(surface, q.data.threadId, ctx.tenantId, ctx.caller);
  if (!thread) {
    res.status(404).json({ error: 'Thread not found' });
    return undefined;
  }
  const client = await getBrowserSessionsServiceClient(ctx.tenantId);
  const { session } = await client.getActiveSessionForThread({
    tenantContext: { tenantId: ctx.tenantId },
    threadId: thread.id,
  });
  return session && session.id === ctx.sessionId ? session : null;
}

// POST /api/threads/:threadId/browser-sessions/ensure
//   body: { agentId: UUID }
//   response: { session, wasNewlyCreated }
browserSessionsRouter.post('/threads/:threadId/browser-sessions/ensure', async (req, res) => {
  const ctx = await authorizeThread(req, res);
  if (!ctx) return;
  const body = z.object({
    agentId: z.string().uuid().optional(),
    // The pane's size at the moment it asked, so a session spawned for it is
    // the pane's size from its first frame.
    viewport: viewportSchema.optional(),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'agentId must be a UUID when present, and viewport an even size within bounds' });
  // Required on AGENT chat and optional nowhere else, because that is exactly
  // where it means something. An agent's session must be spawned against its
  // bindings — a missing agent there would silently hand it the platform
  // browser instead of the vendor it was equipped with. The platform
  // assistants have no agent row to name, and for them the absence is the
  // truth rather than an omission.
  if (ctx.surface === 'agent' && !body.data.agentId) {
    return res.status(400).json({ error: 'agentId required' });
  }
  try {
    const client = await getBrowserSessionsServiceClient(ctx.tenantId);
    const result = await client.ensureSessionForThread({
      tenantContext: { tenantId: ctx.tenantId },
      threadId: ctx.thread.id,
      agentId: body.data.agentId ?? '',
      // The pane can open a session before the assistant calls any tool, so it
      // labels the session too. 'agent' is not an assistant — a team agent is
      // identified by its agentId — so it sends nothing.
      ...(ctx.surface === 'agent' ? {} : { assistant: ctx.surface }),
      ownerAccountId: ctx.caller.accountId, // server-side, never client-supplied
      ...(body.data.viewport ? { viewport: body.data.viewport } : {}),
    });
    // New contract (PR4 paused-frame UX): classified vendor failures come back
    // as a typed `error` envelope on the response body, NOT as an HTTP 5xx.
    // The frontend branches on `error.kind` to render distinct copy
    // (anchor_unavailable | quota_exceeded | invalid_key | unknown), and uses
    // `lastClosedSession` to render the cached frame underneath.
    // Unclassified failures still surface as ConnectError.Internal upstream
    // and land in the catch block below as HTTP 500 — those are operator
    // problems, not user-facing copy branches.
    const ownerCache: OwnerCache = new Map();
    return res.status(200).json({
      session: await sessionJson(result.session, ownerCache, ctx.tenantId, undefined, {
        surface: ctx.surface, callerAccountId: ctx.caller.accountId,
      }),
      // Default to false when the upstream omits the field on the error
      // envelope path — proto3 booleans default to false on the wire but
      // protobuf-es leaves them undefined when unset on the source-side
      // partial, which the frontend would have to null-check. Defaulting
      // here keeps the response shape stable.
      wasNewlyCreated: result.wasNewlyCreated ?? false,
      error: ensureErrorJson(result.error),
      lastClosedSession: await sessionJson(result.lastClosedSession, ownerCache, ctx.tenantId, undefined, {
        surface: ctx.surface, callerAccountId: ctx.caller.accountId,
      }),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'ensure browser session failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/threads/:threadId/browser-sessions/:sessionId/viewport
//   body: { viewport: { width, height } }
//   The pane's size after a resize, debounced by the client; the runtime
//   applies it to the page and keeps it for the next screenshot.
browserSessionsRouter.post('/threads/:threadId/browser-sessions/:sessionId/viewport', async (req, res) => {
  const ctx = await authorizeThread(req, res);
  if (!ctx) return;
  const sessionId = z.string().uuid().safeParse(req.params.sessionId);
  const body = z.object({ viewport: viewportSchema }).safeParse(req.body);
  if (!sessionId.success || !body.success) {
    return res.status(400).json({ error: 'viewport must be an even size within bounds' });
  }
  try {
    const client = await getBrowserSessionsServiceClient(ctx.tenantId);
    const result = await client.setViewport({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId: sessionId.data,
      threadId: ctx.thread.id,
      viewport: body.data.viewport,
    });
    return res.status(200).json({
      applied: result.applied ? { width: result.applied.width, height: result.applied.height } : null,
    });
  } catch (err) {
    const e = err as { code?: string | number; message?: string };
    if (e.code === 'not_found' || e.code === 5) {
      return res.status(404).json({ error: 'Session not found' });
    }
    logger.error({ err: e.message }, 'set browser viewport failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});


// POST /api/browser-sessions/:sessionId/end
//   No body. Owner-only — server returns 403 if caller is not the session owner.
browserSessionsRouter.post('/browser-sessions/:sessionId/end', async (req, res) => {
  const ctx = await authorizeSession(req, res);
  if (!ctx) return;
  try {
    const client = await getBrowserSessionsServiceClient(ctx.tenantId);
    const result = await client.endSession({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId: ctx.sessionId,
      callerAccountId: ctx.caller.accountId,
    });
    return res.status(200).json({ session: await sessionJson(result.session) });
  } catch (err) {
    const e = err as { code?: string | number; message?: string };
    if (e.code === 'permission_denied' || e.code === 7) {
      return res.status(403).json({ error: 'Only the session owner can end this session' });
    }
    if (e.code === 'not_found' || e.code === 5) {
      return res.status(404).json({ error: 'Session not found' });
    }
    logger.error({ err: e.message }, 'end browser session failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/browser-sessions/:sessionId/goto
//   body: { url: string }
browserSessionsRouter.post('/browser-sessions/:sessionId/goto', async (req, res) => {
  const ctx = await authorizeSession(req, res);
  if (!ctx) return;
  const body = z.object({ url: z.string().url() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'url required' });
  // E1: this forwards straight into the tenant's cloud browser, so an
  // unguarded url here is a request made from inside our perimeter — the
  // cloud metadata endpoint included. Validated before the RPC, never after.
  try {
    await assertPublicUrl(body.data.url, { allowHttp: true, context: 'browser-sessions.goto' });
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      return res.status(400).json({ error: 'That address cannot be opened.' });
    }
    throw err;
  }
  try {
    const client = await getBrowserSessionsServiceClient(ctx.tenantId);
    const result = await client.goto({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId: ctx.sessionId,
      url: body.data.url,
    });
    return res.status(200).json({ session: await sessionJson(result.session) });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'goto failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/browser-sessions/:sessionId/page-state
//   response: { url, screenshotSignedUrl, signedUrlExpiresAt }
//   Captures the session's current URL + a fresh signed-URL screenshot.
browserSessionsRouter.get('/browser-sessions/:sessionId/page-state', async (req, res) => {
  const ctx = await authorizeSession(req, res);
  if (!ctx) return;
  try {
    const client = await getBrowserSessionsServiceClient(ctx.tenantId);
    const result = await client.getPageState({
      tenantContext: { tenantId: ctx.tenantId },
      sessionId: ctx.sessionId,
    });
    return res.status(200).json({
      url: result.url,
      screenshotSignedUrl: result.screenshotSignedUrl,
      // Timestamp message carries bigint seconds → convert to RFC3339 (or null).
      signedUrlExpiresAt: result.signedUrlExpiresAt
        ? toJson(TimestampSchema, result.signedUrlExpiresAt)
        : null,
    });
  } catch (err) {
    const e = err as { code?: string | number; message?: string };
    if (e.code === 'not_found' || e.code === 5) {
      return res.status(404).json({ error: 'Session not found' });
    }
    logger.error({ err: e.message }, 'get page state failed');
    return res.status(500).json({ error: 'Internal error' });
  }
});
