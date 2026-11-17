// The recorder attached for the session's lifetime, over fakes.
//
// What is pinned: a warm capture on this instance makes the next pause take
// the fast path (the lease is claimed by the same one UPDATE, the capture
// records under CAPTURE_OWNER and the claimed generation, and nothing
// connects); an instance with no warm capture takes the HoldCapture path;
// a row that arrives with no hold claimed is dropped; a disconnect while
// recording releases the hold as lost_owner; and a second warm attempt on
// the same session gets a world of its own. The real browser behaviours live
// in capture.browser.test.ts.

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../session-vendor-proxy', () => ({ cdpEndpointFor: jest.fn() }));
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }),
}));

const repoMock = {
  claimCapture: jest.fn(),
  renewCapture: jest.fn(),
  releaseCapture: jest.fn(),
  markCaptureGap: jest.fn(),
  insertAction: jest.fn(),
};
jest.mock('../repository', () => repoMock);

import { ensureTakeoverCapture, CAPTURE_OWNER, _activeTakeoverCaptures, _detachAllTakeoverCaptures } from '../index';
import {
  warmSessionCapture, warmCaptureFor, hasWarmSessionCapture, endWarmSessionCapture, LOST_CONTEXT_RETRY_MS,
  _warmSessionCaptures, _endAllSessionCaptures,
} from '../session-capture';
import { TAKEOVER_BINDING } from '../recorder';

const bindingPayload = {
  nonce: 'n', seq: 0, kind: 'click', url: 'https://a.example/', urlTruncated: false, urlProtectedDataOmitted: false,
  tag: 'button', role: 'button', name: 'Go', nameTruncated: false, inputType: '',
  value: '', valueTruncated: false, valueDisposition: 'none', detail: '', detailTruncated: false, at: 1,
};

type Listener = (...args: unknown[]) => void;

function fakeBrowser() {
  const listeners = new Map<string, Listener[]>();
  const on = (map: Map<string, Listener[]>) => (event: string, fn: Listener) => {
    map.set(event, [...(map.get(event) ?? []), fn]);
  };
  const off = (map: Map<string, Listener[]>) => (event: string, fn: Listener) => {
    map.set(event, (map.get(event) ?? []).filter((f) => f !== fn));
  };
  const emit = (map: Map<string, Listener[]>, event: string, ...args: unknown[]) =>
    (map.get(event) ?? []).forEach((fn) => fn(...args));
  const pl = new Map<string, Listener[]>();
  const main = { url: () => 'https://a.example/' };
  const page = { on: on(pl), off: off(pl), frames: () => [main], mainFrame: () => main, _emit: (e: string, ...a: unknown[]) => emit(pl, e, ...a), _listeners: pl };
  const cdpListeners = new Map<string, Listener[]>();
  const cdp = {
    on: on(cdpListeners),
    send: jest.fn(async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      return {};
    }),
    detach: jest.fn(async () => undefined),
    _emit: (e: string, ...a: unknown[]) => emit(cdpListeners, e, ...a),
  };
  const ctxListeners = new Map<string, Listener[]>();
  const context = { pages: () => [page], on: on(ctxListeners), off: off(ctxListeners), newCDPSession: jest.fn(async () => cdp) };
  let connected = true;
  const browser = {
    contexts: () => [context],
    on: on(listeners),
    off: off(listeners),
    isConnected: () => connected,
    close: jest.fn(async () => { connected = false; }),
    _disconnect: () => { connected = false; emit(listeners, 'disconnected'); },
    _page: page,
    _cdp: cdp,
    _context: context,
  };
  return browser;
}

const session = {
  id: 'sid', tenantId: 't', agentId: 'a', threadId: 'th', invocationId: null,
  vendor: 'steel', vendorSessionId: 'vsid', liveViewUrl: null, createdAt: new Date(),
  lastUsedAt: null, expiresAt: null, closedAt: null, closedReason: null,
  takeoverState: 'none' as const, takenOverAt: null, ownerAccountId: null,
  callerSessionId: null, currentUrl: null, lastScreenshotObjectPath: null, lastScreenshotAt: null,
};
const hold = {
  id: 'hold-1', tenantId: 't', sessionId: 'sid', threadId: 'th',
  startedAt: new Date(), endedAt: null, endReason: null,
  captureOwner: null, captureGeneration: 0, captureLeaseUntil: null,
  captureGap: false, gapReason: null,
};

const release = jest.fn();
const acquireFor = (browser: ReturnType<typeof fakeBrowser>) => jest.fn(async () => ({ browser: browser as never, release }));

/** The hold path's connect: never reached on the fast path. */
const connect = jest.fn(async () => { throw new Error('the hold path connected'); });
const holdDeps = { connect, endpointFor: jest.fn(async () => 'ws://x'), renewIntervalMs: 20_000 };

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  await _detachAllTakeoverCaptures();
  await _endAllSessionCaptures();
  repoMock.claimCapture.mockResolvedValue(3);
  repoMock.renewCapture.mockResolvedValue(true);
  repoMock.releaseCapture.mockResolvedValue(undefined);
  repoMock.markCaptureGap.mockResolvedValue(undefined);
  repoMock.insertAction.mockResolvedValue('inserted');
  delete process.env.TR_TAKEOVER_CAPTURE_ENABLED;
});

afterEach(async () => {
  await _detachAllTakeoverCaptures();
  await _endAllSessionCaptures();
  jest.useRealTimers();
});

describe('warming', () => {
  it('installs the recorder in its own world on the pooled browser and holds the connection', async () => {
    const browser = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(browser), ...holdDeps } });
    expect(hasWarmSessionCapture('sid')).toBe(true);
    const facts = _warmSessionCaptures().get('sid')!;
    expect(facts.attached).toBe(true);
    expect(facts.recording).toBeNull();
    expect(facts.world.startsWith('session-sid-')).toBe(true);
    const methods = browser._cdp.send.mock.calls.map((c) => c[0]);
    expect(methods).toEqual([
      'Page.enable', 'Runtime.enable', 'Runtime.addBinding',
      'Page.addScriptToEvaluateOnNewDocument', 'Page.getFrameTree',
      'Page.createIsolatedWorld', 'Runtime.evaluate',
    ]);
    expect(browser._cdp.send).toHaveBeenCalledWith('Runtime.addBinding', { name: TAKEOVER_BINDING, executionContextName: facts.world });
    // Nothing was claimed: no hold is open.
    expect(repoMock.claimCapture).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('a second attempt on the same session gets a world of its own', async () => {
    const first = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(first), ...holdDeps } });
    const world1 = _warmSessionCaptures().get('sid')!.world;
    await endWarmSessionCapture('sid');
    expect(hasWarmSessionCapture('sid')).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(first._cdp.detach).toHaveBeenCalled();
    // The shared connection is left alone: only our sessions were detached.
    expect(first.close).not.toHaveBeenCalled();
    const second = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(second), ...holdDeps } });
    const world2 = _warmSessionCaptures().get('sid')!.world;
    expect(world2).not.toBe(world1);
  });

  it('a warm attempt that does not finish in its budget leaves nothing behind', async () => {
    const browser = fakeBrowser();
    browser._cdp.send.mockImplementation(() => new Promise(() => undefined));
    const done = warmSessionCapture({ tenantId: 't', session }, { timeoutMs: 1_000, deps: { acquire: acquireFor(browser), ...holdDeps } });
    await jest.advanceTimersByTimeAsync(1_100);
    await done;
    expect(hasWarmSessionCapture('sid')).toBe(false);
  });

  it('is skipped when capture is switched off', async () => {
    process.env.TR_TAKEOVER_CAPTURE_ENABLED = '0';
    const browser = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(browser), ...holdDeps } });
    expect(hasWarmSessionCapture('sid')).toBe(false);
    expect(browser._cdp.send).not.toHaveBeenCalled();
  });
});

describe('the fast path on a pause', () => {
  it('a live warm capture claims the lease and records under CAPTURE_OWNER and the claimed generation, with no connect', async () => {
    const browser = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(browser), ...holdDeps } });
    // A row before any hold is dropped: nobody holds the wheel.
    browser._cdp._emit('Runtime.executionContextCreated', { context: { id: 7, name: _warmSessionCaptures().get('sid')!.world, auxData: { isDefault: false } } });
    browser._cdp._emit('Runtime.bindingCalled', { name: TAKEOVER_BINDING, payload: JSON.stringify(bindingPayload), executionContextId: 7 });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).not.toHaveBeenCalled();

    await ensureTakeoverCapture({ tenantId: 't', hold, session: { ...session, takeoverState: 'taken_over' } }, { deps: holdDeps });
    expect(repoMock.claimCapture).toHaveBeenCalledTimes(1);
    expect(repoMock.claimCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER);
    expect(connect).not.toHaveBeenCalled();
    expect(_activeTakeoverCaptures().get('hold-1')).toMatchObject({ holdId: 'hold-1', generation: 3, attached: true });
    expect(_warmSessionCaptures().get('sid')!.recording).toEqual({ holdId: 'hold-1', generation: 3 });

    browser._cdp._emit('Runtime.bindingCalled', { name: TAKEOVER_BINDING, payload: JSON.stringify({ ...bindingPayload, seq: 1 }), executionContextId: 7 });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.insertAction).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 3, expect.objectContaining({ kind: 'click', name: 'Go', seq: 1 }));
    // Renewed on the interval while recording.
    await jest.advanceTimersByTimeAsync(20_000);
    expect(repoMock.renewCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 3);
    // A second pause on the same hold is a no-op.
    await ensureTakeoverCapture({ tenantId: 't', hold, session: { ...session, takeoverState: 'taken_over' } }, { deps: holdDeps });
    expect(repoMock.claimCapture).toHaveBeenCalledTimes(1);
  });

  it('a stale write stops the recording without closing the hold; the recorder stays for the next hold', async () => {
    const browser = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(browser), ...holdDeps } });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: holdDeps });
    const world = _warmSessionCaptures().get('sid')!.world;
    browser._cdp._emit('Runtime.executionContextCreated', { context: { id: 7, name: world, auxData: { isDefault: false } } });
    repoMock.insertAction.mockResolvedValueOnce('stale');
    browser._cdp._emit('Runtime.bindingCalled', { name: TAKEOVER_BINDING, payload: JSON.stringify(bindingPayload), executionContextId: 7 });
    await jest.advanceTimersByTimeAsync(0);
    expect(_warmSessionCaptures().get('sid')!.recording).toBeNull();
    expect(_warmSessionCaptures().get('sid')!.attached).toBe(true);
    expect(repoMock.releaseCapture).not.toHaveBeenCalled();
    // The next hold claims again on the same warm capture.
    repoMock.claimCapture.mockResolvedValueOnce(1);
    await ensureTakeoverCapture({ tenantId: 't', hold: { ...hold, id: 'hold-2' }, session }, { deps: holdDeps });
    expect(_warmSessionCaptures().get('sid')!.recording).toEqual({ holdId: 'hold-2', generation: 1 });
  });

  it('a partial attachment seen at warm time marks every hold it later records', async () => {
    const browser = fakeBrowser();
    browser._cdp.send.mockImplementation(async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' }, childFrames: [{ frame: { id: 'f2' } }] } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      return {};
    });
    // A second page whose CDP session is refused is the partial attachment.
    const refused = { on: jest.fn(), off: jest.fn(), frames: () => [], mainFrame: () => ({ url: () => '' }) };
    browser._context.pages = () => [browser._page, refused as never];
    browser._context.newCDPSession.mockImplementationOnce(async () => browser._cdp).mockImplementationOnce(async () => { throw new Error('refused'); });
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(browser), ...holdDeps } });
    expect(repoMock.markCaptureGap).not.toHaveBeenCalled();
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: holdDeps });
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.markCaptureGap).toHaveBeenCalledWith('t', 'hold-1', 'frame_unavailable');
  });
});

describe('the fallback', () => {
  it('an instance with no warm capture takes the HoldCapture path and connects', async () => {
    const holdBrowser = fakeBrowser();
    const deps = { ...holdDeps, connect: jest.fn(async () => holdBrowser as never) };
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps });
    expect(deps.connect).toHaveBeenCalledTimes(1);
    expect(_activeTakeoverCaptures().get('hold-1')).toMatchObject({ generation: 3, attached: true });
    expect(hasWarmSessionCapture('sid')).toBe(false);
  });
});

describe('losing the connection', () => {
  it('releases the recorded hold as lost_owner and ends the capture', async () => {
    const browser = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(browser), ...holdDeps } });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: holdDeps });
    browser._disconnect();
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.releaseCapture).toHaveBeenCalledWith('t', 'hold-1', CAPTURE_OWNER, 3, 'lost_owner');
    expect(hasWarmSessionCapture('sid')).toBe(false);
    expect(warmCaptureFor('sid')).toBeNull();
    expect(release).toHaveBeenCalled();
  });

  it('with nothing recorded, a disconnect ends the capture and writes nothing', async () => {
    const browser = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(browser), ...holdDeps } });
    browser._disconnect();
    await jest.advanceTimersByTimeAsync(0);
    expect(repoMock.releaseCapture).not.toHaveBeenCalled();
    expect(hasWarmSessionCapture('sid')).toBe(false);
  });
});

describe('idling', () => {
  it('lets the connection go after the idle window with no hold and no pane operation, and not before', async () => {
    const browser = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(browser), ...holdDeps } });
    await jest.advanceTimersByTimeAsync(14 * 60_000);
    expect(hasWarmSessionCapture('sid')).toBe(true);
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(hasWarmSessionCapture('sid')).toBe(false);
    expect(release).toHaveBeenCalled();
  });

  it('never idles out while a hold is being recorded', async () => {
    const browser = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(browser), ...holdDeps } });
    await ensureTakeoverCapture({ tenantId: 't', hold, session }, { deps: holdDeps });
    await jest.advanceTimersByTimeAsync(40 * 60_000);
    expect(hasWarmSessionCapture('sid')).toBe(true);
  });
});

// A context id names one document. When the page swaps documents between the
// lookup and the send, the expression never reaches the page at all — so the
// reader is asked again in the document that is now there, and a reader that
// MUTATES is never run twice off the back of its own failure.
describe('a reader against a document that has just been replaced', () => {
  it('asks once more when the context is gone, and only then', async () => {
    const browser = fakeBrowser();
    await warmSessionCapture({ tenantId: 't', session }, { deps: { acquire: acquireFor(browser), ...holdDeps } });
    const capture = warmCaptureFor('sid')!;

    let evaluates = 0;
    browser._cdp.send.mockImplementation(async (method: string) => {
      if (method !== 'Runtime.evaluate') return {};
      evaluates += 1;
      if (evaluates === 1) throw new Error('cdpSession.send: Protocol error (Runtime.evaluate): Cannot find context with specified id');
      return { result: { value: 'read from the new document' } };
    });
    const answer = capture.evaluate<string>('__liftoffPage.controls({})');
    await jest.advanceTimersByTimeAsync(LOST_CONTEXT_RETRY_MS);
    expect(await answer).toBe('read from the new document');
    expect(evaluates).toBe(2);

    // An expression that threw IN the page has already run: it is not retried.
    evaluates = 0;
    browser._cdp.send.mockImplementation(async (method: string) => {
      if (method !== 'Runtime.evaluate') return {};
      evaluates += 1;
      return { exceptionDetails: { text: 'ReferenceError: nope' } };
    });
    await expect(capture.evaluate('__liftoffPage.focus({})')).rejects.toThrow(/page reader failed/);
    expect(evaluates).toBe(1);
  });
});
