/**
 * BrowserSessionsService RPC handler — verifies:
 *   - tenant mismatch on session-scoped RPCs returns NotFound (never leaks existence)
 *   - listSessionsForThread maps DB rows to proto messages
 *   - pause/resume drive both the Anchor proxy AND the local takeover state
 *   - streamSessionEvents filters by tenant + threadId
 */
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';

const repoMock = {
  listForThread: jest.fn(),
  getActiveForThread: jest.fn(),
  getById: jest.fn(),
  startTakeover: jest.fn(),
  endTakeover: jest.fn(),
  endTakeoverHoldForClose: jest.fn(),
  closeSession: jest.fn(),
  getMostRecentClosedForThread: jest.fn(),
  setLastScreenshot: jest.fn(),
  setViewport: jest.fn(),
  setPageSnapshot: jest.fn(),
};
jest.mock('../repository', () => repoMock);

// Takeover capture is best-effort and bounded; here it is a seam. The pause
// handler must call it AFTER the hold opens and BEFORE it answers.
const ensureTakeoverCaptureMock = jest.fn();
jest.mock('../takeover-capture', () => ({
  ensureTakeoverCapture: (...args: unknown[]) => ensureTakeoverCaptureMock(...args),
}));
const listTakeoverHoldsMock = jest.fn();
jest.mock('../takeover-capture/repository', () => ({
  listTakeoverHolds: (...args: unknown[]) => listTakeoverHoldsMock(...args),
}));

// The ONE recorder of pane browser activity (423). The read RPC lists what it
// wrote; GetPageState records a read only when the caller says so; Goto
// records through the navigation helper.
const recordBrowserActivityMock = jest.fn(async (input: { id: string }) => input.id);
const listBrowserActivityMock = jest.fn();
jest.mock('../activity-repository', () => ({
  recordBrowserActivity: (...args: unknown[]) => recordBrowserActivityMock(...(args as [{ id: string }])),
  listBrowserActivity: (...args: unknown[]) => listBrowserActivityMock(...args),
}));
const navigateAndRecordMock = jest.fn();
jest.mock('../navigate-and-record', () => ({
  PAGE_TITLE_CAP: 400,
  navigateAndRecord: (...args: unknown[]) => navigateAndRecordMock(...args),
}));

// signObjectPath is called inside toProto when a session carries a
// last_screenshot_object_path. Most fixtures don't set one; the tests that do
// stub signObjectPathMock to a stable URL so we can assert it flows through to
// last_screenshot_signed_url on the response.
const signObjectPathMock = jest.fn(async (p: string) => ({
  url: `https://signed/${p}`, expiresAt: new Date('2030-01-01'),
}));

// Every pane operation now routes through the vendor-dispatching proxy and
// takes the session's vendor as its first argument, so these assertions also
// prove the right vendor is dispatched to, not merely that a call happened.
const createAnchorSessionForThreadMock = jest.fn();
const anchorProxyMock = {
  pauseAgent: jest.fn(),
  resumeAgent: jest.fn(),
  respondToIntervention: jest.fn(),
  gotoUrl: jest.fn(),
  getActivePage: jest.fn(),
  runAgentTask: jest.fn(),
  closeSession: jest.fn(),
  fetchScreenshotPng: jest.fn(),
  createSessionForThread: (...args: unknown[]) => createAnchorSessionForThreadMock(...args),
};
jest.mock('../session-vendor-proxy', () => anchorProxyMock);

jest.mock('../../integrations/web-fetch/anchor-client', () => {
  // Preserve AnchorError (the real class) so the classifier's instanceof checks
  // still pattern-match what the tests throw at it.
  const actual = jest.requireActual('../../integrations/web-fetch/anchor-client');
  return { ...actual };
});

const anchorClientMock = anchorProxyMock;
const runBrowserTaskCoreMock = jest.fn();
jest.mock('../../tools/standard-tool-handler', () => ({
  anchorClient: { closeSession: jest.fn(), fetchScreenshotPng: jest.fn() },
  browserUseClient: { closeSession: jest.fn(), fetchScreenshotPng: jest.fn() },
  runBrowserTaskCore: (...args: unknown[]) => runBrowserTaskCoreMock(...args),
}));

const uploadScreenshotAndSignMock = jest.fn();
jest.mock('../screenshot-storage', () => ({
  uploadScreenshotAndSign: (...args: unknown[]) => uploadScreenshotAndSignMock(...args),
  signObjectPath: (...args: unknown[]) => signObjectPathMock(...(args as [string])),
}));

const persistCurrentUrlMock = jest.fn();
jest.mock('../current-url', () => ({
  persistCurrentUrl: (...args: unknown[]) => persistCurrentUrlMock(...args),
}));

// The request for the person to take over (431): no pending request unless
// a test plants one, so the Goto gate lets a navigation through.
const pendingInterventionMock = jest.fn(async () => null);
const requestInterventionMock = jest.fn();
const endInterventionsMock = jest.fn(async () => 0);
const interventionsForHoldsMock = jest.fn(async () => new Map());
const interventionForHoldMock = jest.fn(async () => null);
jest.mock('../interventions', () => ({
  interventionForHold: (...args: unknown[]) => interventionForHoldMock(...(args as [])),
  pendingIntervention: (...args: unknown[]) => pendingInterventionMock(...(args as [])),
  requestIntervention: (...args: unknown[]) => requestInterventionMock(...args),
  endInterventions: (...args: unknown[]) => endInterventionsMock(...(args as [])),
  interventionsForHolds: (...args: unknown[]) => interventionsForHoldsMock(...(args as [])),
  interventionGateMessage: (reason: string) => `You asked the person to take over the browser (${reason}). Until they do, or you withdraw the request with ask_person_to_take_over_browser_session, you can read the browser but not act in it.`,
}));
// The pane actions and the point resolver are their own modules with their
// own suites; here they are seams.
const snapshotPageMock = jest.fn();
const actOnPageMock = jest.fn();
jest.mock('../pane-actions', () => ({
  snapshotPage: (...args: unknown[]) => snapshotPageMock(...args),
  actOnPage: (...args: unknown[]) => actOnPageMock(...args),
  PaneUnavailable: class PaneUnavailable extends Error {},
  PANE_ACTION_KINDS: ['click', 'hover', 'type', 'select', 'press', 'scroll'],
}));
// The pooled connection: no browser in this suite.
const withPageMock = jest.fn(async (_v: string, _s: string, _t: string, fn: (page: unknown) => Promise<unknown>) => fn({ setViewportSize: jest.fn() }));
jest.mock('../cdp-page', () => ({
  withPage: (...args: unknown[]) => withPageMock(...(args as [string, string, string, (page: unknown) => Promise<unknown>])),
  dropConnection: jest.fn(async () => undefined),
  // The real constant: the layout width a pane's viewport is scaled to is
  // the pane's own default, and a mock that dropped it would test a number
  // this module does not use.
  PANE_DIMENSIONS: { width: 1280, height: 800 },
}));
jest.mock('../takeover-capture/session-capture', () => ({
  warmSessionCapture: jest.fn(async () => undefined),
}));
// The downloads body has its own suite (downloads.test.ts); here it is a seam,
// so these tests are about what the RPC does with what it answers.
const listDownloadsForSessionMock = jest.fn();
const fetchFileForSessionMock = jest.fn();
jest.mock('../downloads', () => ({
  listDownloadsForSession: (...args: unknown[]) => listDownloadsForSessionMock(...args),
  fetchFileForSession: (...args: unknown[]) => fetchFileForSessionMock(...args),
}));

const emitBrowserSessionEventMock = jest.fn();
const emitterListeners = new Set<(event: unknown) => void>();
const emitterMock = {
  on: (_evt: string, fn: (event: unknown) => void) => emitterListeners.add(fn),
  off: (_evt: string, fn: (event: unknown) => void) => emitterListeners.delete(fn),
  emit: (_evt: string, payload: unknown) => emitterListeners.forEach((fn) => fn(payload)),
};
jest.mock('../events', () => ({
  emitBrowserSessionEvent: (...args: unknown[]) => emitBrowserSessionEventMock(...args),
  getBrowserSessionEmitter: () => emitterMock,
}));

import registerBrowserSessionsService, { clampViewport } from '../service';

interface Handlers {
  [k: string]: (req: unknown, ctx?: unknown) => Promise<unknown> | AsyncGenerator<unknown>;
}

const handlers: Handlers = {};
const fakeRouter: ConnectRouter = {
  service: (_svc: unknown, h: Record<string, unknown>) => {
    Object.assign(handlers, h);
    return fakeRouter;
  },
} as never;

beforeAll(() => registerBrowserSessionsService(fakeRouter));
beforeEach(() => {
  jest.clearAllMocks();
  emitterListeners.clear();
});

const holdRow = {
  id: 'hold-1', tenantId: 't', sessionId: 'sid', threadId: 'th',
  startedAt: new Date('2026-09-17T10:00:00Z'), endedAt: null, endReason: null,
  captureOwner: null, captureGeneration: 0, captureLeaseUntil: null,
  captureGap: false, gapReason: null,
};

const sessionRow = {
  id: 'sid', tenantId: 't', agentId: 'a', threadId: 'th',
  vendor: 'anchor', vendorSessionId: 'vsid',
  liveViewUrl: 'https://live', createdAt: new Date(),
  lastUsedAt: null, expiresAt: null, closedAt: null,
  closedReason: null,
  takeoverState: 'none' as const, takenOverAt: null,
  ownerAccountId: null, callerSessionId: null, currentUrl: null,
  lastScreenshotObjectPath: null, lastScreenshotAt: null,
};

describe('listSessionsForThread', () => {
  it('lists open sessions for a thread by default', async () => {
    repoMock.listForThread.mockResolvedValueOnce([sessionRow]);
    const result = await handlers.listSessionsForThread({
      tenantContext: { tenantId: 't' },
      threadId: 'th',
      includeClosed: false,
    }) as { sessions: unknown[] };
    expect(repoMock.listForThread).toHaveBeenCalledWith('t', 'th', { includeClosed: false });
    expect(result.sessions).toHaveLength(1);
  });

  it("carries when the address was read and the title read beside it, so a reader orders the page line by the read's own time", async () => {
    repoMock.listForThread.mockResolvedValueOnce([{
      ...sessionRow, currentUrl: 'https://a.example/sports', currentUrlAt: new Date('2026-09-21T10:00:00Z'), currentTitle: 'Sports',
    }]);
    const result = await handlers.listSessionsForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th', includeClosed: false,
    }) as { sessions: Array<{ currentUrl: string; currentUrlAt?: { seconds: bigint }; currentTitle: string }> };
    expect(result.sessions[0]).toMatchObject({ currentUrl: 'https://a.example/sports', currentTitle: 'Sports' });
    expect(result.sessions[0].currentUrlAt?.seconds).toBe(BigInt(Math.floor(new Date('2026-09-21T10:00:00Z').getTime() / 1000)));
    // A row with no read yet: the timestamp is unset and the title empty.
    repoMock.listForThread.mockResolvedValueOnce([sessionRow]);
    const bare = await handlers.listSessionsForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th', includeClosed: false,
    }) as { sessions: Array<{ currentUrlAt?: unknown; currentTitle: string }> };
    expect(bare.sessions[0].currentUrlAt).toBeUndefined();
    expect(bare.sessions[0].currentTitle).toBe('');
  });
});

describe('getActiveSessionForThread', () => {
  // The old NOT_FOUND contract was replaced when we introduced
  // last_closed_session: the frontend needs the closed session row to render
  // the paused-frame UX, and a 404 would force a second RPC. New contract:
  // always success, both fields optional, frontend null-checks `session`.
  it('returns success with neither field set when no sessions exist at all', async () => {
    repoMock.getActiveForThread.mockResolvedValueOnce(null);
    repoMock.getMostRecentClosedForThread.mockResolvedValueOnce(null);
    const result = await handlers.getActiveSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th',
    }) as { session?: unknown; lastClosedSession?: unknown };
    expect(result.session).toBeUndefined();
    expect(result.lastClosedSession).toBeUndefined();
  });

  it('returns last_closed_session with re-signed screenshot URL when an idle-timed-out session exists', async () => {
    repoMock.getActiveForThread.mockResolvedValueOnce(null);
    repoMock.getMostRecentClosedForThread.mockResolvedValueOnce({
      ...sessionRow,
      closedAt: new Date('2026-06-17T20:00:00Z'),
      closedReason: 'idle_timeout',
      lastScreenshotObjectPath: 'tenants/t/vsid/abc.png',
      lastScreenshotAt: new Date('2026-06-17T19:55:00Z'),
    });
    const result = await handlers.getActiveSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th',
    }) as { session?: unknown; lastClosedSession?: Record<string, unknown> };
    expect(result.session).toBeUndefined();
    expect(result.lastClosedSession).toBeDefined();
    // Re-signed URL flows through toProto:
    expect(result.lastClosedSession?.lastScreenshotSignedUrl).toBe(
      'https://signed/tenants/t/vsid/abc.png',
    );
    expect(result.lastClosedSession?.closedReason).toBe('idle_timeout');
    expect(signObjectPathMock).toHaveBeenCalledWith('tenants/t/vsid/abc.png');
  });

  it('prefers the active session and omits last_closed_session even when one exists', async () => {
    repoMock.getActiveForThread.mockResolvedValueOnce(sessionRow);
    // Should not even consult getMostRecentClosedForThread, but tolerate it
    // being called by the Promise.all — the handler just shouldn't return it.
    repoMock.getMostRecentClosedForThread.mockResolvedValueOnce({
      ...sessionRow, closedAt: new Date(), closedReason: 'idle_timeout',
    });
    const result = await handlers.getActiveSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th',
    }) as { session?: unknown; lastClosedSession?: unknown };
    expect(result.session).toBeDefined();
    expect(result.lastClosedSession).toBeUndefined();
  });
});

describe('pauseSession', () => {
  it('returns NotFound on tenant mismatch (never leaks existence)', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, tenantId: 'other' });
    await expect(handlers.pauseSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid',
    })).rejects.toMatchObject({ code: Code.NotFound });
    expect(anchorProxyMock.pauseAgent).not.toHaveBeenCalled();
  });

  it('pauses the Anchor agent, opens the hold with the takeover, attaches capture, then emits SESSION_UPDATED', async () => {
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    const takenOver = { ...sessionRow, takeoverState: 'taken_over' as const };
    const order: string[] = [];
    repoMock.startTakeover.mockImplementationOnce(async () => { order.push('start'); return { session: takenOver, hold: holdRow, renewed: false }; });
    ensureTakeoverCaptureMock.mockImplementationOnce(async () => { order.push('capture'); });

    const result = await handlers.pauseSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid',
    }) as { session: { takeoverState: string } };

    expect(anchorProxyMock.pauseAgent).toHaveBeenCalledWith('anchor', 'vsid', 't');
    expect(repoMock.startTakeover).toHaveBeenCalledWith('sid');
    // The capture attempt happens before the response, so the pane stays
    // non-interactive until the recorder has had its bounded chance.
    expect(ensureTakeoverCaptureMock).toHaveBeenCalledWith({ tenantId: 't', hold: holdRow, session: takenOver });
    expect(order).toEqual(['start', 'capture']);
    expect(emitBrowserSessionEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SESSION_UPDATED' }),
    );
    expect(result.session.takeoverState).toBe('taken_over');
  });

  // Re-issued on an already-paused session this is a lease renewal: the control
  // plane calls it on every poll from the driver so the takeover gate does not
  // expire a hold that a live human is still using. Anchor's agent is already
  // paused, so a second pauseAgent would be a vendor round-trip every 90s for
  // no effect. The capture claim is re-issued every time: a no-op while the
  // owner is alive, and the re-attach when it is not.
  it('restamps without calling Anchor again when the session is already taken over, and still re-claims capture', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, takeoverState: 'taken_over' });
    const takenOver = { ...sessionRow, takeoverState: 'taken_over' as const };
    repoMock.startTakeover.mockResolvedValueOnce({ session: takenOver, hold: holdRow, renewed: true });

    await handlers.pauseSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid',
    });

    expect(anchorProxyMock.pauseAgent).not.toHaveBeenCalled();
    expect(repoMock.startTakeover).toHaveBeenCalledWith('sid');
    expect(ensureTakeoverCaptureMock).toHaveBeenCalledTimes(1);
  });

  it('resumes the vendor agent it just paused and surfaces the failure when the hold cannot open', async () => {
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    repoMock.startTakeover.mockRejectedValueOnce(new Error('db down'));

    await expect(handlers.pauseSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid',
    })).rejects.toThrow('db down');

    expect(anchorProxyMock.pauseAgent).toHaveBeenCalledTimes(1);
    expect(anchorProxyMock.resumeAgent).toHaveBeenCalledWith('anchor', 'vsid', 't');
    expect(ensureTakeoverCaptureMock).not.toHaveBeenCalled();
  });

  it('answers with the session unchanged when it closed between the read and the transition', async () => {
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    repoMock.startTakeover.mockResolvedValueOnce(null);
    const result = await handlers.pauseSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid',
    }) as { session: { id: string } };
    expect(result.session.id).toBe('sid');
    expect(ensureTakeoverCaptureMock).not.toHaveBeenCalled();
  });
});

describe('resumeSession', () => {
  it('resumes the Anchor agent AND ends the takeover as released by default, answering the hold this release ended', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, takeoverState: 'taken_over' });
    repoMock.endTakeover.mockResolvedValueOnce({ session: sessionRow, holdId: 'hold-1' });
    const result = await handlers.resumeSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', endReason: '',
    }) as { holdId: string; session: unknown };
    expect(anchorProxyMock.resumeAgent).toHaveBeenCalledWith('anchor', 'vsid', 't');
    expect(repoMock.endTakeover).toHaveBeenCalledWith('sid', 'released');
    // The control plane hands the person's hand-back into the conversation
    // by this id, and the runtime verifies the claim against its record.
    expect(result.holdId).toBe('hold-1');
    expect(result.session).toBeDefined();
  });

  it('answers an empty hold id when no hold was open', async () => {
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    repoMock.endTakeover.mockResolvedValueOnce({ session: sessionRow, holdId: null });
    const result = await handlers.resumeSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', endReason: '',
    }) as { holdId: string };
    expect(result.holdId).toBe('');
  });

  it("passes the request's reason through: the control plane's sweep names absent_driver", async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, takeoverState: 'taken_over' });
    repoMock.endTakeover.mockResolvedValueOnce({ session: sessionRow, holdId: 'hold-1' });
    await handlers.resumeSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', endReason: 'absent_driver',
    });
    expect(repoMock.endTakeover).toHaveBeenCalledWith('sid', 'absent_driver');
  });

  it('refuses a reason it does not record rather than mislabelling the hold', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, takeoverState: 'taken_over' });
    await expect(handlers.resumeSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', endReason: 'expired',
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(repoMock.endTakeover).not.toHaveBeenCalled();
  });
});

describe('createSessionForThread', () => {
  it('delegates to createAnchorSessionForThread', async () => {
    createAnchorSessionForThreadMock.mockResolvedValueOnce(sessionRow);
    const result = await handlers.createSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th', agentId: 'a',
    }) as { session: unknown };
    expect(createAnchorSessionForThreadMock).toHaveBeenCalledWith({
      tenantId: 't', agentId: 'a', threadId: 'th',
    });
    expect(result.session).toBeDefined();
  });
});

describe('streamSessionEvents', () => {
  it('filters by tenant + threadId and yields when events arrive', async () => {
    const abort = new AbortController();
    const ctx = { signal: abort.signal };
    const gen = (handlers.streamSessionEvents as (
      r: unknown, c: unknown,
    ) => AsyncGenerator<unknown>)(
      { tenantContext: { tenantId: 't' }, threadId: 'th' },
      ctx,
    );

    const next = gen.next();
    // Should drop: wrong tenant.
    emitterMock.emit('event', {
      type: 'SESSION_UPDATED',
      session: { ...sessionRow, tenantId: 'other' },
      emittedAt: new Date(),
    });
    // Should drop: wrong thread.
    emitterMock.emit('event', {
      type: 'SESSION_UPDATED',
      session: { ...sessionRow, threadId: 'other' },
      emittedAt: new Date(),
    });
    // Should yield.
    emitterMock.emit('event', {
      type: 'SESSION_UPDATED',
      session: sessionRow,
      emittedAt: new Date(),
    });
    const result = await next;
    expect(result.done).toBe(false);
    // Drain + abort
    abort.abort();
    await gen.return(undefined);
  });
});

describe('ensureSessionForThread (idempotency)', () => {
  it('returns the existing session with wasNewlyCreated=false when one is live', async () => {
    repoMock.getActiveForThread.mockResolvedValueOnce({ ...sessionRow, ownerAccountId: 'acc-1' });
    const result = await handlers.ensureSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th', agentId: 'a', ownerAccountId: 'acc-1',
    }) as { session: unknown; wasNewlyCreated: boolean };
    expect(result.wasNewlyCreated).toBe(false);
    expect(createAnchorSessionForThreadMock).not.toHaveBeenCalled();
  });

  it('mints a new session with wasNewlyCreated=true when none exists', async () => {
    repoMock.getActiveForThread.mockResolvedValueOnce(null);
    createAnchorSessionForThreadMock.mockResolvedValueOnce({ ...sessionRow, ownerAccountId: 'acc-1' });
    const result = await handlers.ensureSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th', agentId: 'a', ownerAccountId: 'acc-1',
    }) as { wasNewlyCreated: boolean };
    expect(result.wasNewlyCreated).toBe(true);
    // idleTimeoutMinutes was bumped 5 → 10 to match the web_task path so
    // quick thread switches don't keep cold-starting fresh Anchor sessions
    // and reading as sluggishness. See service.ts:228 + the comment there.
    expect(createAnchorSessionForThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't', agentId: 'a', threadId: 'th', ownerAccountId: 'acc-1', idleTimeoutMinutes: 10 }),
    );
  });

  it('rejects with InvalidArgument when ownerAccountId is missing', async () => {
    await expect(handlers.ensureSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th', agentId: 'a', ownerAccountId: '',
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it('recovers from a partial-unique-index race (23505) by re-selecting the winner', async () => {
    repoMock.getActiveForThread
      .mockResolvedValueOnce(null) // initial check: none
      .mockResolvedValueOnce({ ...sessionRow, ownerAccountId: 'acc-1' }); // re-select after race
    const dupErr = Object.assign(new Error('dup'), { code: '23505' });
    createAnchorSessionForThreadMock.mockRejectedValueOnce(dupErr);
    const result = await handlers.ensureSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th', agentId: 'a', ownerAccountId: 'acc-1',
    }) as { wasNewlyCreated: boolean };
    expect(result.wasNewlyCreated).toBe(false);
  });

  // Classified-failure envelope path: instead of throwing ConnectError.Internal
  // (which collapses to a generic "Unable to start" on the frontend), the
  // service wraps the error in a typed envelope so the UI can render copy keyed
  // off the kind. Verifies the envelope carries the kind AND last_closed_session
  // so the paused-frame UX still works even when ensure itself failed.
  it('returns a typed EnsureSessionError envelope (QUOTA_EXCEEDED) with last_closed_session when Anchor returns 402', async () => {
    repoMock.getActiveForThread.mockResolvedValueOnce(null);
    const { AnchorError } = await import('../../integrations/web-fetch/anchor-client');
    createAnchorSessionForThreadMock.mockRejectedValueOnce(
      new AnchorError('Anchor 402: insufficient credits', 402),
    );
    repoMock.getMostRecentClosedForThread.mockResolvedValueOnce({
      ...sessionRow, closedAt: new Date(), closedReason: 'idle_timeout',
      lastScreenshotObjectPath: 'tenants/t/vsid/last.png',
      lastScreenshotAt: new Date(),
    });
    const result = await handlers.ensureSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th', agentId: 'a', ownerAccountId: 'acc-1',
    }) as { session?: unknown; error?: { kind: number; message: string }; lastClosedSession?: unknown };
    expect(result.session).toBeUndefined();
    expect(result.error).toBeDefined();
    // QUOTA_EXCEEDED = 2 per EnsureSessionError.Kind
    expect(result.error?.kind).toBe(2);
    expect(result.error?.message).toContain('402');
    expect(result.lastClosedSession).toBeDefined();
  });

  it('returns ANCHOR_UNAVAILABLE envelope on a 503', async () => {
    repoMock.getActiveForThread.mockResolvedValueOnce(null);
    repoMock.getMostRecentClosedForThread.mockResolvedValueOnce(null);
    const { AnchorError } = await import('../../integrations/web-fetch/anchor-client');
    createAnchorSessionForThreadMock.mockRejectedValueOnce(
      new AnchorError('Anchor 503: unavailable', 503),
    );
    const result = await handlers.ensureSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th', agentId: 'a', ownerAccountId: 'acc-1',
    }) as { error?: { kind: number } };
    // ANCHOR_UNAVAILABLE = 1
    expect(result.error?.kind).toBe(1);
  });

  it('rethrows unclassified errors (DB failures) so they surface as ConnectError.Internal', async () => {
    repoMock.getActiveForThread.mockResolvedValueOnce(null);
    // A plain Error is not AnchorError / BYOKVendorError → classifier returns
    // null → service rethrows. The interceptor would map this to Internal, but
    // unit-level the rejection is the raw Error.
    createAnchorSessionForThreadMock.mockRejectedValueOnce(new Error('connection pool exhausted'));
    await expect(handlers.ensureSessionForThread({
      tenantContext: { tenantId: 't' }, threadId: 'th', agentId: 'a', ownerAccountId: 'acc-1',
    })).rejects.toThrow('connection pool exhausted');
  });
});

describe('endSession (owner-only)', () => {
  it('rejects with PermissionDenied when the caller is not the owner', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, ownerAccountId: 'owner-X' });
    await expect(handlers.endSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', callerAccountId: 'other-Y',
    })).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(anchorClientMock.closeSession).not.toHaveBeenCalled();
    expect(repoMock.closeSession).not.toHaveBeenCalled();
  });

  it('returns NotFound on tenant mismatch (never leaks existence)', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, tenantId: 'other', ownerAccountId: 'acc-1' });
    await expect(handlers.endSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', callerAccountId: 'acc-1',
    })).rejects.toMatchObject({ code: Code.NotFound });
  });

  it('ends the hold, closes Anchor, closes the row (user_ended) through the one writer, then emits SESSION_CLOSED for the owner', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, ownerAccountId: 'acc-1' });
    repoMock.endTakeoverHoldForClose.mockResolvedValueOnce(true);
    repoMock.closeSession.mockResolvedValueOnce({ ...sessionRow, ownerAccountId: 'acc-1', closedAt: new Date() });
    await handlers.endSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', callerAccountId: 'acc-1',
    });
    // The hold ends BEFORE the browser is stopped, so the capture owner's
    // disconnect is not read as a lost observation; the row closes after the
    // vendor answers, which keeps closed_reason honest.
    expect(repoMock.endTakeoverHoldForClose).toHaveBeenCalledWith('sid');
    expect(anchorClientMock.closeSession).toHaveBeenCalledWith('anchor', 'vsid', 't');
    expect(repoMock.closeSession).toHaveBeenCalledWith('sid', 'user_ended');
    const [holdEnd, vendorClose, rowClose] = [
      repoMock.endTakeoverHoldForClose.mock.invocationCallOrder[0],
      anchorClientMock.closeSession.mock.invocationCallOrder[0],
      repoMock.closeSession.mock.invocationCallOrder[0],
    ];
    expect(holdEnd).toBeLessThan(vendorClose);
    expect(vendorClose).toBeLessThan(rowClose);
    expect(emitBrowserSessionEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SESSION_CLOSED' }),
    );
  });

  it('rejects with InvalidArgument when callerAccountId is missing', async () => {
    await expect(handlers.endSession({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', callerAccountId: '',
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });
});

/** Goto is one of the two callers of the navigation helper (the team's
 *  `navigate_browser_session` is the other), so the RPC's own contract is a
 *  mapping: the helper's safe destination, flags and echoed activity id. */
describe('goto', () => {
  const navResult = {
    finalUrl: 'https://x.com/landed?tab=1', finalUrlTruncated: false, finalUrlProtectedDataOmitted: true,
    title: 'Landed', titleTruncated: false, titleProtectedDataOmitted: false,
    requestedUrl: 'https://x.com/', requestedUrlProtectedDataOmitted: false,
    activityId: 'act-1', session: { ...sessionRow, currentUrl: 'https://x.com/landed?tab=1' },
  };

  it('navigates through the one helper under the caller\'s activity id and returns the actual safe destination', async () => {
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    navigateAndRecordMock.mockResolvedValueOnce(navResult);
    const result = await handlers.goto({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', url: 'https://x.com', activityId: 'act-1',
    }) as Record<string, unknown>;
    expect(navigateAndRecordMock).toHaveBeenCalledWith({
      tenantId: 't', session: sessionRow, url: 'https://x.com/', activityId: 'act-1',
    });
    expect(result).toMatchObject({
      finalUrl: 'https://x.com/landed?tab=1', title: 'Landed', activityId: 'act-1',
      finalUrlProtectedDataOmitted: true, finalUrlTruncated: false, titleTruncated: false, titleProtectedDataOmitted: false,
    });
    expect((result.session as { currentUrl: string }).currentUrl).toBe('https://x.com/landed?tab=1');
  });

  it('echoes an empty activity id when the row could not be written: a receipt, not the id\'s source', async () => {
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    navigateAndRecordMock.mockResolvedValueOnce({ ...navResult, activityId: null, session: null });
    const result = await handlers.goto({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', url: 'https://x.com', activityId: '',
    }) as { activityId: string };
    expect(navigateAndRecordMock).toHaveBeenCalledWith({ tenantId: 't', session: sessionRow, url: 'https://x.com/' });
    expect(result.activityId).toBe('');
  });

  it('records nothing before session resolution: a missing session is NotFound and a bad URL InvalidArgument', async () => {
    repoMock.getById.mockResolvedValueOnce(null);
    await expect(handlers.goto({ tenantContext: { tenantId: 't' }, sessionId: 'sid', url: 'https://x.com' }))
      .rejects.toMatchObject({ code: Code.NotFound });
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    await expect(handlers.goto({ tenantContext: { tenantId: 't' }, sessionId: 'sid', url: 'file:///etc/passwd' }))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(navigateAndRecordMock).not.toHaveBeenCalled();
  });

  it('lets the helper\'s failure after session resolution surface as a ConnectError, the row already written', async () => {
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    navigateAndRecordMock.mockRejectedValueOnce(new Error('vendor said no'));
    await expect(handlers.goto({ tenantContext: { tenantId: 't' }, sessionId: 'sid', url: 'https://x.com' }))
      .rejects.toThrow('vendor said no');
  });
});

/** The pane's read. Recording is the caller's say: pane polling, which never
 *  sets record_activity, creates no row. */
describe('getPageState', () => {
  beforeEach(() => {
    anchorProxyMock.getActivePage.mockResolvedValue({ url: 'https://x.com/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=abc', title: 'Reset' });
    anchorProxyMock.fetchScreenshotPng.mockResolvedValue(Buffer.from('png'));
    uploadScreenshotAndSignMock.mockResolvedValue({ url: 'https://signed/x', expiresAt: new Date('2030-01-01'), objectPath: 'p' });
  });

  it('pane polling returns the raw live URL and the safe projection beside it, and records nothing', async () => {
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    const result = await handlers.getPageState({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', recordActivity: false, activityId: '',
    }) as Record<string, unknown>;
    expect(result.url).toBe('https://x.com/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=abc');
    expect(result.recordedUrl).toBe('https://x.com/reset-password/[redacted]?token=[redacted]');
    expect(result.recordedUrlProtectedDataOmitted).toBe(true);
    expect(result.recordedTitle).toBe('Reset');
    expect(result.activityId).toBe('');
    expect(recordBrowserActivityMock).not.toHaveBeenCalled();
    expect(persistCurrentUrlMock).toHaveBeenCalledWith('vsid', 'https://x.com/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=abc', 'Reset');
  });

  it('an assistant\'s read (record_activity) is recorded under the caller\'s id with the safe URL and title only', async () => {
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    const result = await handlers.getPageState({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', recordActivity: true, activityId: 'act-9',
    }) as Record<string, unknown>;
    expect(recordBrowserActivityMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'act-9', tenantId: 't', threadId: 'th', sessionId: 'sid', tool: 'read_active_browser_session',
      outcome: 'read https://x.com/reset-password/[redacted]?token=[redacted]; title: Reset',
      outcomeProtectedDataOmitted: true, steps: null, personTookOver: false,
    }));
    const recorded = recordBrowserActivityMock.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(recorded)).not.toContain('signed');
    expect(JSON.stringify(recorded)).not.toContain('3f2a91b8c07d4e659a1b0d3e5f7a9b1c');
    expect(result.activityId).toBe('act-9');
  });

  it('a screenshot that cannot be taken does not take the read down: the URL and title still answer, the record is written, no screenshot URL', async () => {
    // A zero-width viewport after a hand-back throws in page.screenshot, and
    // the assistant would report it could not see the browser.
    repoMock.getById.mockResolvedValueOnce(sessionRow);
    anchorProxyMock.fetchScreenshotPng.mockRejectedValueOnce(new Error('Protocol error (Page.captureScreenshot): Cannot take screenshot with 0 width.'));
    const result = await handlers.getPageState({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', recordActivity: true, activityId: 'act-10',
    }) as Record<string, unknown>;
    expect(result.recordedUrl).toBe('https://x.com/reset-password/[redacted]?token=[redacted]');
    expect(result.recordedTitle).toBe('Reset');
    expect(result.screenshotSignedUrl).toBe('');
    expect(result.signedUrlExpiresAt).toBeUndefined();
    expect(uploadScreenshotAndSignMock).not.toHaveBeenCalled();
    expect(recordBrowserActivityMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'act-10', tool: 'read_active_browser_session' }));
    expect(result.activityId).toBe('act-10');
  });
});

/** RunBrowserTask exists so the platform assistants — which run in other
 *  services and have no tool context — can drive a browser at all.
 *
 *  What these pin is that it DELEGATES. The handler must stay a mapping layer
 *  over runBrowserTaskCore, because the moment it grows its own copy of the
 *  flow the two entry points can diverge, and what diverges first is a guard:
 *  the takeover gate lives inside that core. */
describe('runBrowserTask', () => {
  it('delegates to the shared core and passes the request through', async () => {
    runBrowserTaskCoreMock.mockResolvedValueOnce({
      success: true, result: { status: 'completed' }, session: sessionRow,
    });

    const result = await handlers.runBrowserTask({
      tenantContext: { tenantId: 't' },
      threadId: 'th',
      prompt: 'book a table',
      ownerAccountId: 'acc-1',
      agentId: '',
    }) as { success: boolean; resultJson: Uint8Array; session?: unknown };

    expect(runBrowserTaskCoreMock).toHaveBeenCalledWith({
      tenantId: 't',
      threadId: 'th',
      prompt: 'book a table',
      ownerAccountId: 'acc-1',
      // An empty proto string is "no agent", not an agent named "". Passing ''
      // through would make the core store it as an agent id and skip the
      // sentinel the session column requires.
      agentId: undefined,
      assistant: undefined,
      activityId: undefined,
    });
    expect(result.success).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(result.resultJson)))
      .toEqual({ status: 'completed' });
    expect(result.session).toBeDefined();
  });

  it('carries a refusal back as success=false rather than throwing', async () => {
    // The core refuses in ways a caller must be able to act on — no human to
    // spawn under, the person holding the keyboard, a session that idled out.
    // Surfacing those as a Connect error would flatten them into "internal
    // error" and lose the reason.
    runBrowserTaskCoreMock.mockResolvedValueOnce({
      success: false,
      error: 'The user has taken over this browser session.',
    });

    const result = await handlers.runBrowserTask({
      tenantContext: { tenantId: 't' },
      threadId: 'th',
      prompt: 'do a thing',
      ownerAccountId: 'acc-1',
      agentId: '',
    }) as { success: boolean; error: string; resultJson: Uint8Array };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/taken over/i);
    expect(result.resultJson).toHaveLength(0);
  });

  it('passes a real agent id through unchanged, so a team agent is unaffected', async () => {
    runBrowserTaskCoreMock.mockResolvedValueOnce({ success: true, result: {} });

    await handlers.runBrowserTask({
      tenantContext: { tenantId: 't' },
      threadId: 'th',
      prompt: 'do a thing',
      ownerAccountId: 'acc-1',
      agentId: 'agent-1',
    });

    expect(runBrowserTaskCoreMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1' }),
    );
  });

  // The trail comes from the core's SEPARATE typed field. It is never parsed
  // out of result_json, and result_json is never changed by its presence.
  it("sets trail from the core's typed field for the loop's shape, byte-identical result_json", async () => {
    const vendorResult = { status: 'finished', result: { message: 'done', lastActions: [{ type: 'act' }] }, data: 'done' };
    runBrowserTaskCoreMock.mockResolvedValueOnce({
      success: true,
      result: vendorResult,
      trail: { message: 'done', steps: [{ type: 'act', action: 'click the Sign in button', pageUrl: 'https://a.example/login' }] },
    });

    const result = await handlers.runBrowserTask({
      tenantContext: { tenantId: 't' }, threadId: 'th', prompt: 'x', ownerAccountId: 'acc-1', agentId: '',
    }) as { resultJson: Uint8Array; trail?: { message: string; steps: Array<{ type: string; action: string; pageUrl: string }> } };

    expect(new TextDecoder().decode(result.resultJson)).toBe(JSON.stringify(vendorResult));
    expect(result.trail).toBeDefined();
    expect(result.trail!.message).toBe('done');
    expect(result.trail!.steps).toEqual([
      expect.objectContaining({ type: 'act', action: 'click the Sign in button', pageUrl: 'https://a.example/login' }),
    ]);
  });

  it('passes the caller\'s activity id to the core and echoes what the core recorded under, with the trail\'s completeness fields', async () => {
    const at = new Date('2026-09-20T10:00:00Z');
    runBrowserTaskCoreMock.mockResolvedValueOnce({
      success: true, result: {}, activityId: 'act-7',
      trail: {
        message: 'done',
        steps: [{
          type: 'change', action: 'entered "browser" in textbox "Search"', pageUrl: 'https://a.example/issues?q=x',
          actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '',
          pageUrlProtectedDataOmitted: false, at,
        }],
        captureGap: true, gapReason: 'frame_unavailable', stepsTruncated: true,
      },
    });
    const result = await handlers.runBrowserTask({
      tenantContext: { tenantId: 't' }, threadId: 'th', prompt: 'x', ownerAccountId: 'acc-1', agentId: '', activityId: 'act-7',
    }) as { activityId: string; trail: { captureGap: boolean; gapReason: string; stepsTruncated: boolean; steps: Array<Record<string, unknown>> } };
    expect(runBrowserTaskCoreMock).toHaveBeenCalledWith(expect.objectContaining({ activityId: 'act-7' }));
    expect(result.activityId).toBe('act-7');
    expect(result.trail).toMatchObject({ captureGap: true, gapReason: 'frame_unavailable', stepsTruncated: true });
    expect(result.trail.steps[0]).toMatchObject({
      type: 'change', protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false,
    });
    expect(Number((result.trail.steps[0].at as { seconds: bigint }).seconds)).toBe(Math.floor(at.getTime() / 1000));
  });

  it('echoes an empty activity id when the core recorded nothing (a refusal before a session)', async () => {
    runBrowserTaskCoreMock.mockResolvedValueOnce({ success: false, error: 'prompt is required' });
    const result = await handlers.runBrowserTask({
      tenantContext: { tenantId: 't' }, threadId: 'th', prompt: '', ownerAccountId: 'acc-1', agentId: '', activityId: 'act-8',
    }) as { activityId: string; session?: unknown };
    expect(result.activityId).toBe('');
    expect(result.session).toBeUndefined();
  });

  it("leaves trail absent for Anchor's shape, which reports no steps", async () => {
    const anchorResult = { status: 'completed', result: { answer: 42 }, data: null };
    runBrowserTaskCoreMock.mockResolvedValueOnce({ success: true, result: anchorResult });

    const result = await handlers.runBrowserTask({
      tenantContext: { tenantId: 't' }, threadId: 'th', prompt: 'x', ownerAccountId: 'acc-1', agentId: '',
    }) as { resultJson: Uint8Array; trail?: unknown };

    expect(result.trail).toBeUndefined();
    expect(new TextDecoder().decode(result.resultJson)).toBe(JSON.stringify(anchorResult));
  });

  it('carries a present-but-empty trail as present: a loop that took no steps', async () => {
    runBrowserTaskCoreMock.mockResolvedValueOnce({
      success: true, result: {}, trail: { message: '', steps: [] },
    });
    const result = await handlers.runBrowserTask({
      tenantContext: { tenantId: 't' }, threadId: 'th', prompt: 'x', ownerAccountId: 'acc-1', agentId: '',
    }) as { trail?: { steps: unknown[] } };
    expect(result.trail).toBeDefined();
    expect(result.trail!.steps).toEqual([]);
  });
});

/** The read behind the Chief AI Officer's view of what the person did. */
describe('listTakeoverActivity', () => {
  const t0 = new Date('2026-09-17T10:00:00Z');
  const hold = (over: Record<string, unknown>) => ({
    id: '11111111-1111-4111-8111-111111111111',
    startedAt: t0, endedAt: new Date('2026-09-17T10:05:00Z'), endReason: 'released',
    captureGap: false, gapReason: null,
    sessionClosedAt: null, sessionTakeoverState: 'none',
    actions: [],
    ...over,
  });

  it('names one hold when asked, takes the newest N actions, and carries the id, kind, omitted count and the request each hold answered', async () => {
    listTakeoverHoldsMock.mockResolvedValueOnce({
      holds: [hold({ kind: 'point', actionsOmitted: 3 })],
      hasMore: false,
    });
    // One hold named is one read, not a batch.
    interventionForHoldMock.mockResolvedValueOnce({ reason: 'sign in', requestedAt: new Date('2026-09-17T09:59:00Z') });
    const result = await handlers.listTakeoverActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 5, beforeCursor: '',
      holdId: '11111111-1111-4111-8111-111111111111', newestActions: 20,
    }) as { holds: Array<{ id: string; kind: string; actionsOmitted: number; interventionReason: string; interventionRequestedAt?: unknown }> };
    expect(listTakeoverHoldsMock).toHaveBeenCalledWith('t', 'th', {
      limit: 5, before: undefined, holdId: '11111111-1111-4111-8111-111111111111', newestActions: 20,
    });
    expect(interventionForHoldMock).toHaveBeenCalledWith('t', '11111111-1111-4111-8111-111111111111');
    expect(interventionsForHoldsMock).not.toHaveBeenCalled();
    expect(result.holds[0]).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', kind: 'point', actionsOmitted: 3, interventionReason: 'sign in' });
    expect(result.holds[0].interventionRequestedAt).toBeDefined();
    // A hold id that is not a UUID matches nothing rather than throwing.
    const none = await handlers.listTakeoverActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 5, beforeCursor: '', holdId: 'nope',
    }) as { holds: unknown[] };
    expect(none.holds).toEqual([]);
  });

  it("computes live from the joined session row: no end, session open, still taken over", async () => {
    listTakeoverHoldsMock.mockResolvedValueOnce({
      holds: [hold({ endedAt: null, endReason: null, sessionTakeoverState: 'taken_over' })],
      hasMore: false,
    });
    const result = await handlers.listTakeoverActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 5, beforeCursor: '',
    }) as { holds: Array<{ live: boolean; endedAt?: unknown; captureGap: boolean; gapReason: string }>; nextCursor: string };
    expect(result.holds[0].live).toBe(true);
    expect(result.holds[0].endedAt).toBeUndefined();
    // Live is not a gap: captureGap stays whatever the hold recorded.
    expect(result.holds[0].captureGap).toBe(false);
    expect(result.holds[0].gapReason).toBe('');
    expect(result.nextCursor).toBe('');
  });

  it('applies the orphan rule only when live is false: end from the session close, gap lost_owner, nothing fabricated', async () => {
    const closedAt = new Date('2026-09-17T10:30:00Z');
    listTakeoverHoldsMock.mockResolvedValueOnce({
      holds: [
        hold({ endedAt: null, endReason: null, sessionClosedAt: closedAt, sessionTakeoverState: 'none' }),
        hold({ id: '22222222-2222-4222-8222-222222222222', endedAt: null, endReason: null, sessionClosedAt: null, sessionTakeoverState: 'none', captureGap: true, gapReason: 'cap' }),
      ],
      hasMore: false,
    });
    const result = await handlers.listTakeoverActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 5, beforeCursor: '',
    }) as { holds: Array<{ live: boolean; endedAt?: { seconds: bigint }; endReason: string; captureGap: boolean; gapReason: string }> };
    const [closed, unknown] = result.holds;
    expect(closed.live).toBe(false);
    expect(Number(closed.endedAt!.seconds)).toBe(Math.floor(closedAt.getTime() / 1000));
    expect(closed.captureGap).toBe(true);
    expect(closed.gapReason).toBe('lost_owner');
    expect(closed.endReason).toBe('');
    // No session close to borrow an end from: the end stays unknown, and an
    // earlier gap reason is kept rather than overwritten.
    expect(unknown.endedAt).toBeUndefined();
    expect(unknown.captureGap).toBe(true);
    expect(unknown.gapReason).toBe('cap');
  });

  it('orders actions as the repository returns them and exposes only the wire fields', async () => {
    const a1 = new Date('2026-09-17T10:01:00Z');
    const a2 = new Date('2026-09-17T10:02:00Z');
    listTakeoverHoldsMock.mockResolvedValueOnce({
      holds: [hold({
        actions: [
          { kind: 'navigate', url: 'https://a.example/orders/:id', tag: null, role: null, name: null, inputType: null, at: a1 },
          { kind: 'click', url: 'https://a.example/orders/:id', tag: 'button', role: 'button', name: 'Approve invoice', inputType: null, at: a2 },
        ],
      })],
      hasMore: false,
    });
    const result = await handlers.listTakeoverActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 5, beforeCursor: '',
    }) as { holds: Array<{ actions: Array<Record<string, unknown>> }> };
    const [nav, click] = result.holds[0].actions;
    expect(nav).toMatchObject({ kind: 'navigate', url: 'https://a.example/orders/:id', tag: '', role: '', name: '', inputType: '' });
    expect(click).toMatchObject({ kind: 'click', tag: 'button', role: 'button', name: 'Approve invoice' });
    expect(Object.keys(click).sort()).toEqual([
      '$typeName', 'at', 'detail', 'detailProtectedDataOmitted', 'detailTruncated', 'inputType', 'kind', 'name',
      'nameProtectedDataOmitted', 'nameTruncated', 'role', 'tag', 'url', 'urlProtectedDataOmitted', 'urlTruncated',
      'value', 'valueDisposition', 'valueTruncated',
    ]);
  });

  it('carries the value, its disposition and every flag: a recorded value, an omitted class, and the legacy row', async () => {
    const at = new Date('2026-09-17T10:01:00Z');
    const base = {
      url: 'https://a.example/issues?q=browser', urlTruncated: false, urlProtectedDataOmitted: false,
      tag: 'input', role: 'textbox', name: 'Search all issues', nameTruncated: false, nameProtectedDataOmitted: false,
      inputType: 'text', detail: null, detailTruncated: false, detailProtectedDataOmitted: false, at,
    };
    listTakeoverHoldsMock.mockResolvedValueOnce({
      holds: [hold({
        actions: [
          { ...base, kind: 'change', value: 'browser', valueTruncated: false, valueDisposition: 'recorded' },
          { ...base, kind: 'enter', value: null, valueTruncated: false, valueDisposition: 'authentication_omitted', inputType: 'password', name: 'Password' },
          { ...base, kind: 'change', value: null, valueTruncated: false, valueDisposition: 'legacy_unavailable' },
          { ...base, kind: 'key', value: null, valueTruncated: false, valueDisposition: 'none', detail: 'Control+Enter', detailTruncated: true },
        ],
      })],
      hasMore: false,
    });
    const result = await handlers.listTakeoverActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 5, beforeCursor: '',
    }) as { holds: Array<{ actions: Array<Record<string, unknown>> }> };
    const [recorded, omitted, legacy, key] = result.holds[0].actions;
    // protobuf-es strips the enum prefix: VALUE_DISPOSITION_RECORDED is 2.
    expect(recorded).toMatchObject({ kind: 'change', value: 'browser', valueDisposition: 2 });
    expect(omitted).toMatchObject({ kind: 'enter', value: '', valueDisposition: 3, inputType: 'password' });
    expect(legacy).toMatchObject({ valueDisposition: 8 });
    expect(key).toMatchObject({ kind: 'key', detail: 'Control+Enter', detailTruncated: true, valueDisposition: 1 });
  });

  it('pages on (started_at, id): the cursor names the last hold of the page and round-trips without skipping equal timestamps', async () => {
    listTakeoverHoldsMock.mockResolvedValueOnce({
      holds: [hold({}), hold({ id: '22222222-2222-4222-8222-222222222222', startedAt: t0 })],
      hasMore: true,
    });
    const first = await handlers.listTakeoverActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 2, beforeCursor: '',
    }) as { nextCursor: string };
    expect(listTakeoverHoldsMock).toHaveBeenCalledWith('t', 'th', { limit: 2, before: undefined });
    expect(first.nextCursor).not.toBe('');

    listTakeoverHoldsMock.mockResolvedValueOnce({ holds: [], hasMore: false });
    await handlers.listTakeoverActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 2, beforeCursor: first.nextCursor,
    });
    // The second page asks for holds strictly before the pair, so a hold that
    // shares the last timestamp but has a different id is still reachable.
    expect(listTakeoverHoldsMock).toHaveBeenLastCalledWith('t', 'th', {
      limit: 2,
      before: { startedAt: t0, id: '22222222-2222-4222-8222-222222222222' },
    });
  });

  it('clamps limit to [1, 5]: too large reads as 5, unset (0) and negative read as 1', async () => {
    listTakeoverHoldsMock.mockResolvedValue({ holds: [], hasMore: false });
    await handlers.listTakeoverActivity({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 50, beforeCursor: '' });
    expect(listTakeoverHoldsMock).toHaveBeenLastCalledWith('t', 'th', expect.objectContaining({ limit: 5 }));
    await handlers.listTakeoverActivity({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 0, beforeCursor: '' });
    expect(listTakeoverHoldsMock).toHaveBeenLastCalledWith('t', 'th', expect.objectContaining({ limit: 1 }));
    await handlers.listTakeoverActivity({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: -3, beforeCursor: '' });
    expect(listTakeoverHoldsMock).toHaveBeenLastCalledWith('t', 'th', expect.objectContaining({ limit: 1 }));
    await handlers.listTakeoverActivity({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 3, beforeCursor: '' });
    expect(listTakeoverHoldsMock).toHaveBeenLastCalledWith('t', 'th', expect.objectContaining({ limit: 3 }));
  });

  it('rejects a cursor it did not issue', async () => {
    await expect(handlers.listTakeoverActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 5, beforeCursor: 'not-a-cursor',
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });
});

/** The read behind every host's view of the pane's work. */
describe('listBrowserActivity', () => {
  const t0 = new Date('2026-09-20T10:00:00Z');
  const row = (over: Record<string, unknown>) => ({
    id: '11111111-1111-4111-8111-111111111111', tool: 'run_browser_task', instruction: 'open the issues page',
    outcome: 'done', personTookOver: false, steps: null, createdAt: t0,
    instructionTruncated: false, outcomeTruncated: false, captureGap: false, gapReason: '', stepsTruncated: false,
    instructionProtectedDataOmitted: false, outcomeProtectedDataOmitted: false,
    ...over,
  });

  it('clamps limit to [1, 50]: too large reads as 50, unset (0) reads as 1', async () => {
    listBrowserActivityMock.mockResolvedValue({ rows: [], hasMore: false });
    await handlers.listBrowserActivity({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 500, beforeCursor: '' });
    expect(listBrowserActivityMock).toHaveBeenLastCalledWith('t', 'th', expect.objectContaining({ limit: 50 }));
    await handlers.listBrowserActivity({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 0, beforeCursor: '' });
    expect(listBrowserActivityMock).toHaveBeenLastCalledWith('t', 'th', expect.objectContaining({ limit: 1 }));
    await handlers.listBrowserActivity({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 7, beforeCursor: '' });
    expect(listBrowserActivityMock).toHaveBeenLastCalledWith('t', 'th', expect.objectContaining({ limit: 7 }));
  });

  it('maps rows to the wire: has_steps is presence, an empty list is a real value, and the completeness fields pass through', async () => {
    const at = '2026-09-20T10:00:05.000Z';
    listBrowserActivityMock.mockResolvedValueOnce({
      rows: [
        row({ steps: [{
          type: 'goto', action: 'https://a.example/', pageUrl: 'https://a.example/', actionTruncated: false, pageUrlTruncated: false,
          protectedDataOmitted: true, protectedKind: 'authentication', pageUrlProtectedDataOmitted: false, at,
        }], captureGap: true, gapReason: 'cap', stepsTruncated: true, instructionTruncated: true, outcomeProtectedDataOmitted: true }),
        row({ id: '22222222-2222-4222-8222-222222222222', tool: 'navigate_browser_session', steps: null }),
        row({ id: '33333333-3333-4333-8333-333333333333', steps: [], personTookOver: true }),
      ],
      hasMore: false,
    });
    const result = await handlers.listBrowserActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 10, beforeCursor: '',
    }) as { rows: Array<Record<string, unknown>>; nextCursor: string };
    const [task, nav, empty] = result.rows;
    expect(task).toMatchObject({
      hasSteps: true, captureGap: true, gapReason: 'cap', stepsTruncated: true, instructionTruncated: true, outcomeProtectedDataOmitted: true,
    });
    expect((task.steps as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'goto', protectedDataOmitted: true, protectedKind: 'authentication' });
    expect(nav).toMatchObject({ hasSteps: false, steps: [] });
    expect(empty).toMatchObject({ hasSteps: true, steps: [], personTookOver: true });
    expect(result.nextCursor).toBe('');
  });

  it('pages on (created_at, id) and round-trips the cursor', async () => {
    listBrowserActivityMock.mockResolvedValueOnce({ rows: [row({}), row({ id: '22222222-2222-4222-8222-222222222222' })], hasMore: true });
    const first = await handlers.listBrowserActivity({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 2, beforeCursor: '',
    }) as { nextCursor: string };
    expect(first.nextCursor).not.toBe('');
    listBrowserActivityMock.mockResolvedValueOnce({ rows: [], hasMore: false });
    await handlers.listBrowserActivity({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 2, beforeCursor: first.nextCursor });
    expect(listBrowserActivityMock).toHaveBeenLastCalledWith('t', 'th', {
      limit: 2, before: { createdAt: t0, id: '22222222-2222-4222-8222-222222222222' },
    });
  });

  it('rejects a cursor it did not issue, and a missing thread', async () => {
    await expect(handlers.listBrowserActivity({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 5, beforeCursor: 'nope' }))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(handlers.listBrowserActivity({ tenantContext: { tenantId: 't' }, threadId: '', limit: 5, beforeCursor: '' }))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
  });
});

// ── The RPCs the browser copilot added (0.26.0) ─────────────────────────────

describe('the thread-scoped pane RPCs', () => {
  const threadSession = { ...sessionRow, vendor: 'steel', threadId: 'th' };

  it('refuse a session that is not the named thread\'s with NotFound, so a caller authorized on one thread cannot reach another\'s browser', async () => {
    repoMock.getById.mockResolvedValue(threadSession);
    for (const call of [
      () => handlers.snapshotPage({ tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'other', recordActivity: false, activityId: '', includeText: false, startAt: 0 }),
      () => handlers.actOnPage({ tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'other', snapshotId: 's', action: 'click', ref: 'c0', text: '', submit: false, value: '', key: '', direction: '', amount: 0, activityId: '' }),
      () => handlers.requestIntervention({ tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'other', reason: 'x', requestedByInvocationId: '', withdraw: false }),
      () => handlers.setViewport({ tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'other', viewport: { width: 800, height: 600 } }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: Code.NotFound });
    }
    expect(snapshotPageMock).not.toHaveBeenCalled();
    expect(actOnPageMock).not.toHaveBeenCalled();
  });

  it('snapshotPage reads through the pane module with the caller\'s flags and echoes the id when recorded', async () => {
    repoMock.getById.mockResolvedValue(threadSession);
    snapshotPageMock.mockResolvedValue({
      id: 'snap-1', url: { text: 'https://a.example/', truncated: false, protectedDataOmitted: false }, title: { text: 'A', truncated: false, protectedDataOmitted: false },
      controls: [{ ref: 'c0', role: 'link', name: 'Sports', inputType: '', valueState: '', disabled: false, protectedKind: '', offscreen: false, nameTruncated: false, nameProtectedDataOmitted: false }],
      controlsTruncated: true, total: 300, startAt: 120, framesNotListed: false, text: { text: '# A', truncated: false, protectedDataOmitted: false }, activityId: 'act-1',
    });
    const result = await handlers.snapshotPage({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', recordActivity: true, activityId: 'act-1', includeText: true, startAt: 120,
    }) as { snapshotId: string; controls: unknown[]; total: number; controlsTruncated: boolean; text: string; activityId: string };
    expect(snapshotPageMock).toHaveBeenCalledWith(threadSession, 't', { includeText: true, recordActivity: true, activityId: 'act-1', startAt: 120 });
    expect(result).toMatchObject({ snapshotId: 'snap-1', total: 300, controlsTruncated: true, text: '# A', activityId: 'act-1' });
    expect(result.controls).toHaveLength(1);
  });

  it('actOnPage carries the refusal kind, the cover and the takeover-during flag on the wire', async () => {
    repoMock.getById.mockResolvedValue(threadSession);
    actOnPageMock.mockResolvedValue({
      acted: false, refusalKind: 'obscured', message: 'Something covers that control: dialog "Cookie preferences".', coveredBy: 'dialog "Cookie preferences"',
      personTookOverDuring: false, url: { text: '', truncated: false, protectedDataOmitted: false }, title: { text: '', truncated: false, protectedDataOmitted: false }, activityId: 'act-2',
    });
    const result = await handlers.actOnPage({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', snapshotId: 'snap-1', action: 'click', ref: 'c0',
      text: '', submit: false, value: '', key: '', direction: '', amount: 0, activityId: 'act-2',
    }) as { acted: boolean; refusalKind: string; coveredBy: string; message: string; activityId: string };
    expect(actOnPageMock).toHaveBeenCalledWith(threadSession, 't', 'snap-1', { action: 'click', ref: 'c0' }, 'act-2');
    expect(result).toMatchObject({ acted: false, refusalKind: 'obscured', coveredBy: 'dialog "Cookie preferences"', activityId: 'act-2' });
    expect(result.message).toContain('Cookie preferences');
  });

  it('actOnPage answers a pending request for the person as FailedPrecondition with its sentence, as Goto does, and an unknown action as InvalidArgument', async () => {
    repoMock.getById.mockResolvedValue(threadSession);
    const gate = 'You asked the person to take over the browser (sign in). Until they do, or you withdraw the request with ask_person_to_take_over_browser_session, you can read the browser but not act in it.';
    actOnPageMock.mockResolvedValueOnce({
      acted: false, refusalKind: 'intervention_pending', message: gate, coveredBy: '', personTookOverDuring: false,
      url: { text: '', truncated: false, protectedDataOmitted: false }, title: { text: '', truncated: false, protectedDataOmitted: false }, activityId: 'act-3',
    });
    await expect(handlers.actOnPage({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', snapshotId: 'snap-1', action: 'click', ref: 'c0',
      text: '', submit: false, value: '', key: '', direction: '', amount: 0, activityId: 'act-3',
    })).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: gate });
    actOnPageMock.mockClear();
    await expect(handlers.actOnPage({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', snapshotId: 'snap-1', action: 'dance', ref: 'c0',
      text: '', submit: false, value: '', key: '', direction: '', amount: 0, activityId: '',
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(actOnPageMock).not.toHaveBeenCalled();
  });

  it('requestIntervention asks, answers alreadyPending, withdraws, and puts the request on the session', async () => {
    repoMock.getById.mockResolvedValue(threadSession);
    requestInterventionMock.mockResolvedValueOnce({ intervention: { id: 'req-1' }, alreadyPending: false });
    pendingInterventionMock.mockResolvedValueOnce({ id: 'req-1', reason: 'sign in', requestedAt: new Date('2026-09-21T21:03:00Z'), requestedByInvocationId: 'inv-1' });
    const asked = await handlers.requestIntervention({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', reason: 'sign in', requestedByInvocationId: 'inv-1', withdraw: false,
    }) as { interventionId: string; alreadyPending: boolean; withdrawn: boolean; session: { intervention?: { id: string; reason: string } } };
    expect(requestInterventionMock).toHaveBeenCalledWith({ tenantId: 't', sessionId: 'sid', threadId: 'th', reason: 'sign in', requestedByInvocationId: 'inv-1' });
    expect(asked).toMatchObject({ interventionId: 'req-1', alreadyPending: false, withdrawn: false });
    // toProto fills the session's intervention: the reason is model-only on the wire.
    expect(asked.session.intervention).toMatchObject({ id: 'req-1', reason: 'sign in' });
    expect(emitBrowserSessionEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'SESSION_UPDATED' }));

    endInterventionsMock.mockResolvedValueOnce(1);
    const withdrawn = await handlers.requestIntervention({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', reason: '', requestedByInvocationId: '', withdraw: true,
    }) as { withdrawn: boolean };
    expect(endInterventionsMock).toHaveBeenCalledWith(undefined, 'sid', 'cancelled', 't');
    expect(withdrawn.withdrawn).toBe(true);

    await expect(handlers.requestIntervention({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', reason: '   ', requestedByInvocationId: '', withdraw: false,
    })).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it('the Goto RPC refuses a navigation with FailedPrecondition while a request for the person is pending', async () => {
    repoMock.getById.mockResolvedValue(threadSession);
    pendingInterventionMock.mockResolvedValueOnce({ id: 'req-1', reason: 'sign in', requestedAt: new Date(), requestedByInvocationId: null });
    await expect(handlers.goto({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', url: 'https://a.example/', activityId: 'act-1',
    })).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: expect.stringContaining('You asked the person to take over the browser (sign in)') });
    expect(navigateAndRecordMock).not.toHaveBeenCalled();
  });


  it('setViewport clamps, applies and stores the size, answering what was applied', async () => {
    repoMock.getById.mockResolvedValue(threadSession);
    repoMock.setViewport.mockResolvedValueOnce(threadSession);
    const result = await handlers.setViewport({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', viewport: { width: 3000, height: 481 },
    }) as { applied: { width: number; height: number } };
    expect(result.applied).toMatchObject({ width: 1920, height: 482 });
    expect(withPageMock).toHaveBeenCalled();
    expect(repoMock.setViewport).toHaveBeenCalledWith('sid', { width: 1920, height: 482 });
  });

  // A pane session is released at the vendor on its own idle timeout, and the
  // pane goes on reporting its size as the person drags it. That is the
  // ordinary end of a session, not an internal failure, so a resize must not
  // answer 500. NotFound is what every other read of a
  // session that is gone answers, and what tells the pane to open a new one.
  it('setViewport answers NotFound when the vendor released the session, rather than failing internally', async () => {
    repoMock.getById.mockResolvedValue(threadSession);
    const released = Object.assign(new Error('steel session vs-1 is released'), { statusCode: 410 });
    withPageMock.mockRejectedValueOnce(released);
    await expect(handlers.setViewport({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', viewport: { width: 1280, height: 800 },
    })).rejects.toMatchObject({ code: Code.NotFound });
    expect(repoMock.setViewport).not.toHaveBeenCalled();
  });

  it('setViewport still surfaces a failure that is not a released session', async () => {
    repoMock.getById.mockResolvedValue(threadSession);
    withPageMock.mockRejectedValueOnce(new Error('the page crashed'));
    await expect(handlers.setViewport({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', viewport: { width: 1280, height: 800 },
    })).rejects.toThrow('the page crashed');
  });

  // The pane is a side panel and its live view scales the page into it. A
  // viewport set to the pane's own pixels laid every site out at a tablet
  // width; what the viewport takes from the pane is its shape.
  it('setViewport lays the page out at a desktop width, in the pane\'s shape', async () => {
    repoMock.getById.mockResolvedValue(threadSession);
    repoMock.setViewport.mockResolvedValue(threadSession);
    const result = await handlers.setViewport({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', threadId: 'th', viewport: { width: 786, height: 538 },
    }) as { applied: { width: number; height: number } };
    expect(result.applied.width).toBe(1280);
    // 538 x (1280/786) = 876.0..., to the nearest even number.
    expect(result.applied.height).toBe(876);
    const aspect = (w: number, h: number) => Math.round((w / h) * 100) / 100;
    expect(aspect(result.applied.width, result.applied.height)).toBe(aspect(786, 538));
  });
});

describe('clampViewport', () => {
  it('scales a narrow pane up to the layout width, keeping its shape', () => {
    expect(clampViewport({ width: 520, height: 700 })).toEqual({ width: 1280, height: 1200 });
    expect(clampViewport({ width: 640, height: 400 })).toEqual({ width: 1280, height: 800 });
  });

  it('leaves a pane already at least the layout width as it is', () => {
    expect(clampViewport({ width: 1440, height: 900 })).toEqual({ width: 1440, height: 900 });
    expect(clampViewport({ width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 });
  });

  it('never exceeds the bounds, whatever the scale asks for', () => {
    expect(clampViewport({ width: 360, height: 1000 })).toEqual({ width: 1280, height: 1200 });
    expect(clampViewport({ width: 4000, height: 2000 })).toEqual({ width: 1920, height: 1200 });
  });

  it('answers null for a request that carried no size', () => {
    expect(clampViewport(undefined)).toBeNull();
    expect(clampViewport({ width: 0, height: 0 })).toBeNull();
    expect(clampViewport({ width: 800 })).toBeNull();
  });
});

// The two RPCs the three platform assistants reach downloads through. They
// exist because the assistants run their tool loops in the platform backend
// and cannot call the runtime's own tools; without them, "bring me that file"
// was answerable for an agent and not for Liftoff, the Insights Manager or
// the Chief AI Officer.
describe('the session\'s files', () => {
  it('lists what the session downloaded, whatever vendor it runs on', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, vendor: 'steel' });
    listDownloadsForSessionMock.mockResolvedValueOnce([{
      id: 'd-1', url: 'https://cdn/clip.mp4', suggestedFileName: 'clip.mp4',
      originUrl: 'https://maker/', downloadedAt: '2026-09-25T10:00:00.000Z',
    }]);
    const result = await handlers.listSessionDownloads({
      tenantContext: { tenantId: 't' }, sessionId: 'sid',
    }) as { downloads: Array<{ id: string; url: string; suggestedFileName: string }> };
    expect(result.downloads).toHaveLength(1);
    expect(result.downloads[0].suggestedFileName).toBe('clip.mp4');
  });

  it('never tells another workspace whether a session exists', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, tenantId: 'someone-else' });
    await expect(handlers.listSessionDownloads({ tenantContext: { tenantId: 't' }, sessionId: 'sid' }))
      .rejects.toMatchObject({ code: Code.NotFound });
  });

  it('fetches a file by the address the page points at, and answers its bytes', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, vendor: 'steel' });
    fetchFileForSessionMock.mockResolvedValueOnce({
      bytes: Buffer.from('mp4 bytes'), filename: 'clip.mp4', contentType: 'video/mp4',
      sourceUrl: 'https://maker/studio',
    });
    const result = await handlers.fetchSessionFile({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', downloadId: '', url: 'https://cdn/clip.mp4',
    }) as { content: Uint8Array; contentType: string; filename: string; refusal: string };
    expect(Buffer.from(result.content).toString()).toBe('mp4 bytes');
    expect(result.contentType).toBe('video/mp4');
    expect(result.refusal).toBe('');
  });

  // The reason is the useful thing: a caller that got an exception would have
  // to invent a sentence for the person, which is how a person gets told the
  // browser is gone when the file was merely too big.
  it('answers a refusal with the reason, rather than throwing', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, vendor: 'steel' });
    const tooLarge = new Error('the file is 120 MB, over the 40 MB a file card takes');
    tooLarge.name = 'FileTooLarge';
    fetchFileForSessionMock.mockRejectedValueOnce(tooLarge);
    const result = await handlers.fetchSessionFile({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', downloadId: '', url: 'https://cdn/huge.mp4',
    }) as { content: Uint8Array; refusal: string };
    expect(result.refusal).toMatch(/over the 40 MB/);
    expect(result.content.length).toBe(0);
  });

  it('still throws what nobody reasoned about', async () => {
    repoMock.getById.mockResolvedValueOnce({ ...sessionRow, vendor: 'steel' });
    fetchFileForSessionMock.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(handlers.fetchSessionFile({
      tenantContext: { tenantId: 't' }, sessionId: 'sid', downloadId: 'd-1', url: '',
    })).rejects.toThrow(/socket hang up/);
  });
});
