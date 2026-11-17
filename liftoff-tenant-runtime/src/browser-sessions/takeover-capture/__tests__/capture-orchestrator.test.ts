// The capture orchestrator over fakes: when it claims, renews, releases.
//
// The lease is only honest while the recorder is installed, so the properties
// here are about that coupling. A renewal is issued only while a page has the
// recorder; no page, no renewal. A failed attach releases as never_attached;
// an installed recorder that loses its browser releases as lost_owner; a
// renewal that finds its generation gone detaches without touching the hold;
// a timeout aborts the attach and a connection that lands late is closed. The
// real browser behaviours live in capture.browser.test.ts.

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Never load the vendor clients here; the endpoint is injected.
jest.mock('../../session-vendor-proxy', () => ({ cdpEndpointFor: jest.fn() }));

const repoMock = {
  claimCapture: jest.fn(),
  renewCapture: jest.fn(),
  releaseCapture: jest.fn(),
  markCaptureGap: jest.fn(),
  insertAction: jest.fn(),
};
jest.mock('../repository', () => repoMock);

import {
  ensureTakeoverCapture,
  CAPTURE_OWNER,
  _activeTakeoverCaptures,
  _detachAllTakeoverCaptures,
} from '../index';

/** A binding payload exactly as the recorder sends one, every strict field
 *  present. Tests spread over it. */
const bindingPayload = {
  nonce: 'n', seq: 0, kind: 'click', url: 'https://a.example/', urlTruncated: false, urlProtectedDataOmitted: false,
  tag: 'button', role: 'button', name: 'Go', nameTruncated: false, inputType: '',
  value: '', valueTruncated: false, valueDisposition: 'none', detail: '', detailTruncated: false, at: 1,
};

type Listener = (...args: unknown[]) => void;

/** A browser as the orchestrator sees it: contexts, pages, CDP sessions. */
function fakeBrowser(opts: { pages?: number; cdpFails?: boolean } = {}) {
  const listeners = new Map<string, Listener[]>();
  const on = (map: Map<string, Listener[]>) => (event: string, fn: Listener) => {
    map.set(event, [...(map.get(event) ?? []), fn]);
  };
  const emit = (map: Map<string, Listener[]>, event: string, ...args: unknown[]) =>
    (map.get(event) ?? []).forEach((fn) => fn(...args));
  const pageListeners: Array<Map<string, Listener[]>> = [];
  const makePage = () => {
    const pl = new Map<string, Listener[]>();
    pageListeners.push(pl);
    const main = { url: () => 'https://a.example/' };
    return { on: on(pl), frames: () => [main], mainFrame: () => main, _emit: (e: string, ...a: unknown[]) => emit(pl, e, ...a) };
  };
  const pages = Array.from({ length: opts.pages ?? 1 }, makePage);
  const cdp = {
    on: jest.fn(),
    send: jest.fn(async (method: string) => {
      if (opts.cdpFails) throw new Error('target crashed');
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      return {};
    }),
  };
  const ctxListeners = new Map<string, Listener[]>();
  const context = {
    pages: () => pages,
    on: on(ctxListeners),
    newCDPSession: jest.fn(async () => cdp),
  };
  const browser = {
    contexts: () => [context],
    on: on(listeners),
    close: jest.fn(async () => undefined),
    _disconnect: () => emit(listeners, 'disconnected'),
    _pages: pages,
    _cdp: cdp,
  };
  return browser;
}

const hold = {
  id: 'hold-1', tenantId: 't', sessionId: 'sid', threadId: 'th',
  startedAt: new Date(), endedAt: null, endReason: null,
  captureOwner: null, captureGeneration: 0, captureLeaseUntil: null,
  captureGap: false, gapReason: null,
};
const session = {
  id: 'sid', tenantId: 't', agentId: 'a', threadId: 'th', invocationId: null,
  vendor: 'steel', vendorSessionId: 'vsid', liveViewUrl: null, createdAt: new Date(),
  lastUsedAt: null, expiresAt: null, closedAt: null, closedReason: null,
  takeoverState: 'taken_over' as const, takenOverAt: new Date(), ownerAccountId: null,
  callerSessionId: null, currentUrl: null, lastScreenshotObjectPath: null, lastScreenshotAt: null,
};

const deps = (browser: ReturnType<typeof fakeBrowser>, extra: Record<string, unknown> = {}) => ({
  connect: jest.fn(async () => browser as never),
  endpointFor: jest.fn(async () => 'ws://127.0.0.1:1/devtools/browser/x'),
  renewIntervalMs: 20_000,
  ...extra,
});

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  await _detachAllTakeoverCaptures();
  repoMock.claimCapture.mockResolvedValue(1);
  repoMock.renewCapture.mockResolvedValue(true);
  repoMock.releaseCapture.mockResolvedValue(undefined);
  repoMock.markCaptureGap.mockResolvedValue(undefined);
  repoMock.insertAction.mockResolvedValue('inserted');
  delete process.env.TR_TAKEOVER_CAPTURE_ENABLED;
});

afterEach(async () => {
  await _detachAllTakeoverCaptures();
  jest.useRealTimers();
});

describe('claiming', () => {
  it('installs every frame of a target at once, so a page with many frames attaches within the budget', async () => {
    // A news page with dozens of same-process frames can spend the whole
    // attach budget on a sequential walk, and the person's first minute of
    // driving goes unrecorded. Forty child frames at forty
    // milliseconds a round trip: sequential would need over three seconds;
    // together, the walk is two round trips.
    const browser = fakeBrowser();
    const ROUND_TRIP_MS = 40;
    const children = Array.from({ length: 40 }, (_, i) => ({ frame: { id: `child-${i}` } }));
    browser._cdp.send.mockImplementation((method: string) => new Promise((resolve) => setTimeout(() => {
      if (method === 'Page.getFrameTree') resolve({ frameTree: { frame: { id: 'f1' }, childFrames: children } });
      else if (method === 'Page.createIsolatedWorld') resolve({ executionContextId: 7 });
      else resolve({});
    }, ROUND_TRIP_MS)));
    const done = ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser), timeoutMs: 5_000 });
    // Five sequential setup round trips, then the worlds and evaluations
    // of all forty-one frames in flight together.
    await jest.advanceTimersByTimeAsync(ROUND_TRIP_MS * 9);
    await done;
    const worlds = browser._cdp.send.mock.calls.filter((c) => c[0] === 'Page.createIsolatedWorld');
    expect(worlds).toHaveLength(41);
    expect(repoMock.markCaptureGap).not.toHaveBeenCalled();
    expect(_activeTakeoverCaptures().get('hold-1')?.attached).toBe(true);
  });

  it('claims under this process, attaches in A.3 order, and renews on the interval while a page has the recorder', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });

    expect(repoMock.claimCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER);
    const methods = browser._cdp.send.mock.calls.map((c) => c[0]);
    expect(methods).toEqual([
      'Page.enable', 'Runtime.enable', 'Runtime.addBinding',
      'Page.addScriptToEvaluateOnNewDocument', 'Page.getFrameTree',
      'Page.createIsolatedWorld', 'Runtime.evaluate',
    ]);
    // Subscriptions were registered before the world was created.
    const subscribed = browser._cdp.on.mock.calls.map((c) => c[0]);
    expect(subscribed).toEqual(['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.bindingCalled']);
    expect(_activeTakeoverCaptures().get('hold-1')).toMatchObject({ generation: 1, attached: true });

    // One renewal at connect: the lease is re-checked against the database
    // before anything is installed. Then one per interval while attached.
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(1);
    expect(repoMock.renewCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 1);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(3);
  });

  it('re-checks the lease after connecting and installs nothing when the hold ended or another generation took over', async () => {
    const browser = fakeBrowser();
    repoMock.renewCapture.mockResolvedValueOnce(false);
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    expect(browser._cdp.send).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
    expect(_activeTakeoverCaptures().has('hold-1')).toBe(false);
    // Not ours to release: nothing is written to the hold.
    expect(repoMock.releaseCapture).not.toHaveBeenCalled();
  });

  it('counts a target as installed only while a world of the hold is live: a failed evaluation is not counted', async () => {
    const browser = fakeBrowser();
    browser._cdp.send.mockImplementation(async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') throw new Error('Execution context was destroyed');
      return {};
    });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    expect(repoMock.releaseCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 1, 'never_attached');
    expect(_activeTakeoverCaptures().has('hold-1')).toBe(false);
  });

  it('stops counting a target whose world was destroyed, and counts it again when the init script makes a new one', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    const created = browser._cdp.on.mock.calls.find((c) => c[0] === 'Runtime.executionContextCreated')![1] as (p: unknown) => void;
    const destroyed = browser._cdp.on.mock.calls.find((c) => c[0] === 'Runtime.executionContextDestroyed')![1] as (p: unknown) => void;
    destroyed({ executionContextId: 7 });
    expect(_activeTakeoverCaptures().get('hold-1')!.attached).toBe(false);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(1); // only the connect-time re-check
    created({ context: { id: 8, name: 'takeover-hold-1', auxData: { isDefault: false } } });
    expect(_activeTakeoverCaptures().get('hold-1')!.attached).toBe(true);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(2);
  });

  it('does nothing when another owner holds a live lease, and records no gap', async () => {
    repoMock.claimCapture.mockResolvedValueOnce(null);
    const browser = fakeBrowser();
    const d = deps(browser);
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: d });
    expect(d.connect).not.toHaveBeenCalled();
    expect(repoMock.releaseCapture).not.toHaveBeenCalled();
    expect(repoMock.markCaptureGap).not.toHaveBeenCalled();
  });

  it('is a no-op on a hold this process already records', async () => {
    const browser = fakeBrowser();
    const d = deps(browser);
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: d });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: d });
    expect(repoMock.claimCapture).toHaveBeenCalledTimes(1);
    expect(d.connect).toHaveBeenCalledTimes(1);
  });

  it('skips the claim and marks the hold disabled when the flag is 0', async () => {
    process.env.TR_TAKEOVER_CAPTURE_ENABLED = '0';
    const d = deps(fakeBrowser());
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: d });
    expect(repoMock.claimCapture).not.toHaveBeenCalled();
    expect(d.connect).not.toHaveBeenCalled();
    expect(repoMock.markCaptureGap).toHaveBeenCalledWith('t', 'hold-1', 'disabled');
  });
});

describe('the lease is only held while observing', () => {
  it('issues no renewal when no page has the recorder: a browser with no pages fails the attach and releases never_attached', async () => {
    const browser = fakeBrowser({ pages: 0 });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    expect(repoMock.releaseCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 1, 'never_attached');
    expect(browser.close).toHaveBeenCalled();
    expect(_activeTakeoverCaptures().has('hold-1')).toBe(false);
    // The one renewal is the connect-time re-check; none follows on the interval.
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(1);
  });

  it('releases never_attached when the recorder could not be installed in any page', async () => {
    const browser = fakeBrowser({ cdpFails: true });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    expect(repoMock.releaseCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 1, 'never_attached');
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(1);
  });

  it('releases never_attached when the endpoint cannot be reached', async () => {
    const d = deps(fakeBrowser(), { connect: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: d });
    expect(repoMock.releaseCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 1, 'never_attached');
  });

  it('releases lost_owner when an installed recorder loses its browser, even with no actions taken', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    browser._disconnect();
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.releaseCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 1, 'lost_owner');
    expect(_activeTakeoverCaptures().has('hold-1')).toBe(false);
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(repoMock.renewCapture).toHaveBeenCalledTimes(1);
  });

  it('releases lost_owner when the last page goes away', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    browser._pages[0]._emit('close');
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.releaseCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 1, 'lost_owner');
  });

  it('detaches locally, never closing the hold, when a renewal finds its generation gone', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    repoMock.renewCapture.mockResolvedValueOnce(false);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(browser.close).toHaveBeenCalled();
    expect(_activeTakeoverCaptures().has('hold-1')).toBe(false);
    // Our own close is not a disconnect: nothing is released, nothing ended.
    expect(repoMock.releaseCapture).not.toHaveBeenCalled();
  });

  it('detaches locally when a write finds the generation stale', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    repoMock.insertAction.mockResolvedValueOnce('stale');
    browser._pages[0]._emit('framenavigated', browser._pages[0].mainFrame());
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 1, expect.objectContaining({ kind: 'navigate', url: 'https://a.example/' }));
    expect(_activeTakeoverCaptures().has('hold-1')).toBe(false);
    expect(repoMock.releaseCapture).not.toHaveBeenCalled();
  });
});

/** A KNOWN partial attachment marks the hold `frame_unavailable` while the
 *  capture stays live for the targets that did attach. */
describe('partial attachment', () => {
  it('a second page whose CDP session is refused marks the hold frame_unavailable and the first page keeps recording', async () => {
    const browser = fakeBrowser({ pages: 2 });
    let calls = 0;
    browser.contexts()[0].newCDPSession.mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new Error('Target closed');
      return browser._cdp as never;
    });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.markCaptureGap).toHaveBeenCalledWith('t', 'hold-1', 'frame_unavailable');
    expect(repoMock.releaseCapture).not.toHaveBeenCalled();
    expect(_activeTakeoverCaptures().get('hold-1')?.attached).toBe(true);
    // The first page's recorder still delivers.
    const deliver = browser._cdp.on.mock.calls.find((c) => c[0] === 'Runtime.bindingCalled')![1] as (p: unknown) => void;
    deliver({ name: '__liftoffTakeoverRecord', executionContextId: 7, payload: JSON.stringify(bindingPayload) });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).toHaveBeenCalledTimes(1);
  });

  it("a main-frame world that cannot be created marks the hold, a sub-frame world failure in an attached target does not", async () => {
    const browser = fakeBrowser();
    browser._cdp.send.mockImplementation(async (method: string, params?: { frameId?: string }) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'sub' } }] } };
      if (method === 'Page.createIsolatedWorld') {
        if (params?.frameId === 'sub') throw new Error('No frame for given id found');
        return { executionContextId: 7 };
      }
      return {};
    });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.markCaptureGap).not.toHaveBeenCalled();

    await _detachAllTakeoverCaptures();
    jest.clearAllMocks();
    repoMock.claimCapture.mockResolvedValue(1);
    repoMock.renewCapture.mockResolvedValue(true);
    repoMock.markCaptureGap.mockResolvedValue(undefined);
    const second = fakeBrowser({ pages: 2 });
    let worlds = 0;
    second._cdp.send.mockImplementation(async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') {
        worlds++;
        // The second target's own main frame refuses a world.
        if (worlds === 2) throw new Error('Cannot find context with specified id');
        return { executionContextId: 7 };
      }
      return {};
    });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(second) });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.markCaptureGap).toHaveBeenCalledWith('t', 'hold-1', 'frame_unavailable');
    expect(_activeTakeoverCaptures().get('hold-1')?.attached).toBe(true);
  });
});

describe('navigations', () => {
  it('records a redirect or reload chain to one destination once, and a navigation after another action again', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    const page = browser._pages[0];
    const main = page.mainFrame();
    // The handler keys on identity with page.mainFrame(), as Playwright's
    // frames are, so the main frame object itself moves to the new URL.
    const navigate = (url: string) => { Object.assign(main, { url: () => url }); page._emit('framenavigated', main); };
    // An http -> https bounce and a consent reload: three frame events, one
    // destination, one row. The query string and fragment are fidelity data
    // now, so only an IDENTICAL safe URL folds; `?after=1` is a distinct page.
    navigate('https://a.example/commits?after=1');
    navigate('https://a.example/commits?after=1');
    navigate('https://a.example/commits?after=1');
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).toHaveBeenCalledTimes(1);
    expect(repoMock.insertAction).toHaveBeenLastCalledWith('t', 'hold-1', CAPTURE_OWNER, 1,
      expect.objectContaining({ kind: 'navigate', url: 'https://a.example/commits?after=1', seq: 0, urlProtectedDataOmitted: false }));

    navigate('https://a.example/pulls');
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).toHaveBeenCalledTimes(2);

    // A click in between, then the same page again: that is a reload the
    // person caused, and it is kept.
    const deliver = browser._cdp.on.mock.calls.find((c) => c[0] === 'Runtime.bindingCalled')![1] as (p: unknown) => void;
    deliver({ name: '__liftoffTakeoverRecord', executionContextId: 7, payload: JSON.stringify({
      ...bindingPayload, url: 'https://a.example/pulls', name: 'Reload',
    }) });
    navigate('https://a.example/pulls');
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).toHaveBeenCalledTimes(4);
    expect(repoMock.insertAction).toHaveBeenLastCalledWith('t', 'hold-1', CAPTURE_OWNER, 1,
      expect.objectContaining({ kind: 'navigate', url: 'https://a.example/pulls', seq: 2 }));

    // A reset token in the path is replaced before the row is queued, and the
    // row says so.
    navigate('https://a.example/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=abc');
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).toHaveBeenLastCalledWith('t', 'hold-1', CAPTURE_OWNER, 1,
      expect.objectContaining({ kind: 'navigate', url: 'https://a.example/reset-password/[redacted]?token=[redacted]', urlProtectedDataOmitted: true }));
  });
});

describe('what reaches the repository from a binding call', () => {
  function bindingHandler(browser: ReturnType<typeof fakeBrowser>) {
    const call = browser._cdp.on.mock.calls.find((c) => c[0] === 'Runtime.bindingCalled')!;
    return call[1] as (params: { name: string; payload: string; executionContextId: number }) => void;
  }
  function contextCreated(browser: ReturnType<typeof fakeBrowser>) {
    const call = browser._cdp.on.mock.calls.find((c) => c[0] === 'Runtime.executionContextCreated')!;
    return call[1] as (params: { context: { id: number; name: string; auxData: unknown } }) => void;
  }
  const payload = JSON.stringify(bindingPayload);

  it('accepts only the recorder binding from a context of the hold\'s own world', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    const deliver = bindingHandler(browser);
    // Context 7 is the isolated world Page.createIsolatedWorld returned.
    deliver({ name: 'somethingElse', payload, executionContextId: 7 });
    deliver({ name: '__liftoffTakeoverRecord', payload, executionContextId: 999 });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).not.toHaveBeenCalled();
    deliver({ name: '__liftoffTakeoverRecord', payload, executionContextId: 7 });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).toHaveBeenCalledTimes(1);
    expect(repoMock.insertAction).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 1, {
      nonce: 'n', seq: 0, kind: 'click', url: 'https://a.example/', urlTruncated: false, urlProtectedDataOmitted: false,
      tag: 'button', role: 'button', name: 'Go', nameTruncated: false, nameProtectedDataOmitted: false, inputType: null,
      value: null, valueTruncated: false, valueDisposition: 'none', detail: null, detailTruncated: false, detailProtectedDataOmitted: false,
    });
  });

  it('sanitizes a row before it lands: a credential-shaped recorded value is dropped as sensitive_text_omitted, a name is redacted with its flag', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    const deliver = bindingHandler(browser);
    deliver({ name: '__liftoffTakeoverRecord', executionContextId: 7, payload: JSON.stringify({
      ...bindingPayload, kind: 'change', value: 'ghp_' + 'a'.repeat(36), valueDisposition: 'recorded',
      name: 'Token ghp_' + 'b'.repeat(36),
    }) });
    deliver({ name: '__liftoffTakeoverRecord', executionContextId: 7, payload: JSON.stringify({
      ...bindingPayload, seq: 1, kind: 'change', value: 'quarterly report', valueDisposition: 'recorded',
    }) });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).toHaveBeenNthCalledWith(1, 't', 'hold-1', CAPTURE_OWNER, 1, expect.objectContaining({
      value: null, valueDisposition: 'sensitive_text_omitted', name: 'Token [REDACTED]', nameProtectedDataOmitted: true,
    }));
    expect(repoMock.insertAction).toHaveBeenNthCalledWith(2, 't', 'hold-1', CAPTURE_OWNER, 1, expect.objectContaining({
      value: 'quarterly report', valueDisposition: 'recorded',
    }));
    expect(JSON.stringify(repoMock.insertAction.mock.calls)).not.toContain('ghp_');
  });

  it('a card number, an identity number or a tokenized address typed into an ordinary field is dropped the same way; an ordinary long number stays', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    const deliver = bindingHandler(browser);
    const values = ['4111 1111 1111 1111', '123-45-6789', 'see https://a.example/reset?token=abc123', 'order 1234567890123 for 12 Rue de la Paix'];
    values.forEach((value, seq) => deliver({ name: '__liftoffTakeoverRecord', executionContextId: 7, payload: JSON.stringify({
      ...bindingPayload, seq, kind: 'change', value, valueDisposition: 'recorded', name: 'Notes',
    }) }));
    await jest.advanceTimersByTimeAsync(0);
    for (const n of [1, 2, 3]) {
      expect(repoMock.insertAction).toHaveBeenNthCalledWith(n, 't', 'hold-1', CAPTURE_OWNER, 1, expect.objectContaining({
        value: null, valueDisposition: 'sensitive_text_omitted',
      }));
    }
    expect(repoMock.insertAction).toHaveBeenNthCalledWith(4, 't', 'hold-1', CAPTURE_OWNER, 1, expect.objectContaining({
      value: 'order 1234567890123 for 12 Rue de la Paix', valueDisposition: 'recorded',
    }));
    expect(JSON.stringify(repoMock.insertAction.mock.calls)).not.toMatch(/4111|123-45-6789|token=abc123/);
  });

  it('tracks a world created for a new document by name and non-default flag, and ignores the page\'s own world', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    contextCreated(browser)({ context: { id: 42, name: 'takeover-hold-1', auxData: { isDefault: false } } });
    contextCreated(browser)({ context: { id: 43, name: '', auxData: { isDefault: true } } });
    const deliver = bindingHandler(browser);
    deliver({ name: '__liftoffTakeoverRecord', payload, executionContextId: 43 });
    deliver({ name: '__liftoffTakeoverRecord', payload, executionContextId: 42 });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).toHaveBeenCalledTimes(1);
  });

  it('drops a payload that does not match the strict schema', async () => {
    const browser = fakeBrowser();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: deps(browser) });
    const deliver = bindingHandler(browser);
    deliver({ name: '__liftoffTakeoverRecord', payload: JSON.stringify({ kind: 'click', value: 'hunter2' }), executionContextId: 7 });
    deliver({ name: '__liftoffTakeoverRecord', payload: 'not json', executionContextId: 7 });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).not.toHaveBeenCalled();
  });
});

describe('the bounded attach', () => {
  it('times out, releases never_attached, and closes a connection that lands late without resurrecting the capture', async () => {
    const browser = fakeBrowser();
    let resolveConnect: (b: unknown) => void = () => undefined;
    const d = deps(browser, {
      connect: jest.fn(() => new Promise((resolve) => { resolveConnect = resolve; })),
    });
    const pending = ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: d, timeoutMs: 1_000 });
    await jest.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(repoMock.releaseCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 1, 'never_attached');
    expect(_activeTakeoverCaptures().has('hold-1')).toBe(false);

    resolveConnect(browser);
    await jest.advanceTimersByTimeAsync(0);
    expect(browser.close).toHaveBeenCalled();
    expect(browser._cdp.send).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    // Aborted before the connect-time re-check: no renewal was ever issued.
    expect(repoMock.renewCapture).not.toHaveBeenCalled();
  });
});
