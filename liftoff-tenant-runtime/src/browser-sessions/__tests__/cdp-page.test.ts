/**
 * The pooled CDP connection every pane operation shares.
 *
 * What is pinned: a hit is reused and a miss connects once; concurrent first
 * callers share one connect; a dead entry reconnects; another tenant's
 * request for the same session is refused; the idle close is skipped while
 * a capture holds the connection; the cap evicts the least recently used
 * idle entry; dropConnection closes before the vendor is told; and a
 * disconnect during an operation fails that operation once and replays
 * nothing.
 */

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const queryMock = jest.fn(async () => ({ rows: [] }));
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => queryMock(...(a as [])) }),
}));

type Listener = (...args: unknown[]) => void;

interface FakeBrowser {
  listeners: Map<string, Listener[]>;
  connected: boolean;
  on(event: string, fn: Listener): void;
  off(event: string, fn: Listener): void;
  isConnected(): boolean;
  contexts(): Array<{ pages(): unknown[] }>;
  close: jest.Mock;
  /** Simulate the socket dying under us. */
  die(): void;
}

function fakeBrowser(): FakeBrowser {
  const page = { url: () => 'https://x.test/', title: async () => 'X' };
  const b: FakeBrowser = {
    listeners: new Map(),
    connected: true,
    on(event, fn) { b.listeners.set(event, [...(b.listeners.get(event) ?? []), fn]); },
    off(event, fn) { b.listeners.set(event, (b.listeners.get(event) ?? []).filter((f) => f !== fn)); },
    isConnected: () => b.connected,
    contexts: () => [{ pages: () => [page] }],
    close: jest.fn(async () => { b.connected = false; }),
    die() {
      b.connected = false;
      for (const fn of b.listeners.get('disconnected') ?? []) fn();
    },
  };
  return b;
}

const connectOverCDPMock = jest.fn();
jest.mock('playwright-core', () => ({
  chromium: { connectOverCDP: (...a: unknown[]) => connectOverCDPMock(...a) },
}));

const cdpEndpointForMock = jest.fn();
jest.mock('../session-vendor-proxy', () => ({
  cdpEndpointFor: (...a: unknown[]) => cdpEndpointForMock(...a),
}));
jest.mock('../takeover-capture/session-capture', () => ({
  hasWarmSessionCapture: () => true,
  warmSessionCapture: jest.fn(),
}));
const getByVendorSessionIdMock = jest.fn(async (id: string) => ({ id: `row-${id}`, tenantId: 't1', closedAt: null }));
jest.mock('../repository', () => ({
  getByVendorSessionId: (...a: unknown[]) => getByVendorSessionIdMock(...(a as [string])),
}));
const recordDownloadMock = jest.fn(async () => undefined);
const keepDownloadBytesMock = jest.fn(async () => undefined);
jest.mock('../downloads', () => ({
  recordDownload: (...a: unknown[]) => recordDownloadMock(...a),
  keepDownloadBytes: (...a: unknown[]) => keepDownloadBytesMock(...a),
}));

import {
  CDP_IDLE_CLOSE_MS, CDP_POOL_CAP, _cdpPoolEntries, _closeCdpPool, _downloadsArmedFor, dropConnection,
  holdConnection, withPage, withPooledBrowser,
} from '../cdp-page';

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  cdpEndpointForMock.mockImplementation(async (_v: string, id: string, _t: string, opts?: { fresh?: boolean }) =>
    opts?.fresh ? `wss://fresh/${id}` : `wss://stored/${id}`);
});

afterEach(async () => {
  await _closeCdpPool();
  jest.useRealTimers();
});

describe('withPooledBrowser', () => {
  it('a miss connects once through the stored endpoint and a hit reuses the browser', async () => {
    const browser = fakeBrowser();
    connectOverCDPMock.mockResolvedValue(browser);
    await withPage('steel', 's1', 't1', async (page) => page.url());
    const title = await withPage('steel', 's1', 't1', async (page) => page.title());
    expect(title).toBe('X');
    expect(connectOverCDPMock).toHaveBeenCalledTimes(1);
    expect(connectOverCDPMock).toHaveBeenCalledWith('wss://stored/s1');
    expect(browser.close).not.toHaveBeenCalled();
    expect(_cdpPoolEntries().get('steel:s1')).toMatchObject({ tenantId: 't1', connected: true, inFlight: 0 });
  });

  it('a dead entry reconnects', async () => {
    const first = fakeBrowser();
    const second = fakeBrowser();
    connectOverCDPMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await withPooledBrowser('steel', 's1', 't1', async () => undefined);
    first.die();
    expect(_cdpPoolEntries().has('steel:s1')).toBe(false);
    const got = await withPooledBrowser('steel', 's1', 't1', async (b) => b);
    expect(got).toBe(second);
    expect(connectOverCDPMock).toHaveBeenCalledTimes(2);
  });

  it('concurrent first callers share one connect', async () => {
    jest.useRealTimers();
    const browser = fakeBrowser();
    connectOverCDPMock.mockImplementation(() => new Promise((resolve) => { setTimeout(() => resolve(browser), 20); }));
    const a = withPooledBrowser('steel', 's1', 't1', async (b) => b);
    const b = withPooledBrowser('steel', 's1', 't1', async (b) => b);
    expect(await a).toBe(browser);
    expect(await b).toBe(browser);
    expect(connectOverCDPMock).toHaveBeenCalledTimes(1);
  });

  it('only a connect is retried: a stored endpoint that does not connect is refetched from the vendor, before the operation', async () => {
    const browser = fakeBrowser();
    connectOverCDPMock.mockRejectedValueOnce(new Error('stale')).mockResolvedValueOnce(browser);
    const fn = jest.fn(async () => 'ok');
    await expect(withPooledBrowser('steel', 's1', 't1', fn)).resolves.toBe('ok');
    expect(connectOverCDPMock.mock.calls.map((c) => c[0])).toEqual(['wss://stored/s1', 'wss://fresh/s1']);
    expect(cdpEndpointForMock).toHaveBeenLastCalledWith('steel', 's1', 't1', { fresh: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a hit for another tenant is refused', async () => {
    connectOverCDPMock.mockResolvedValue(fakeBrowser());
    await withPooledBrowser('steel', 's1', 't1', async () => undefined);
    await expect(withPooledBrowser('steel', 's1', 't2', async () => undefined))
      .rejects.toThrow(/belongs to another tenant/);
    expect(connectOverCDPMock).toHaveBeenCalledTimes(1);
  });

  it('a disconnect during an operation fails that operation once and never replays it', async () => {
    const browser = fakeBrowser();
    connectOverCDPMock.mockResolvedValue(browser);
    const fn = jest.fn(async () => {
      browser.die();
      throw new Error('Target closed');
    });
    await expect(withPooledBrowser('steel', 's1', 't1', fn)).rejects.toThrow('Target closed');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(_cdpPoolEntries().has('steel:s1')).toBe(false);
  });
});

describe('the idle close', () => {
  it('closes a connection nothing used for the idle window', async () => {
    const browser = fakeBrowser();
    connectOverCDPMock.mockResolvedValue(browser);
    await withPooledBrowser('steel', 's1', 't1', async () => undefined);
    jest.advanceTimersByTime(CDP_IDLE_CLOSE_MS + 1);
    await Promise.resolve();
    expect(browser.close).toHaveBeenCalled();
    expect(_cdpPoolEntries().has('steel:s1')).toBe(false);
  });

  it('is skipped while a capture holds the connection, and resumes when the hold is released', async () => {
    const browser = fakeBrowser();
    connectOverCDPMock.mockResolvedValue(browser);
    await withPooledBrowser('steel', 's1', 't1', async () => undefined);
    const release = holdConnection('steel', 's1');
    jest.advanceTimersByTime(CDP_IDLE_CLOSE_MS * 3);
    await Promise.resolve();
    expect(browser.close).not.toHaveBeenCalled();
    expect(_cdpPoolEntries().get('steel:s1')?.holds).toBe(1);
    release();
    jest.advanceTimersByTime(CDP_IDLE_CLOSE_MS + 1);
    await Promise.resolve();
    expect(browser.close).toHaveBeenCalled();
  });
});

describe('the cap', () => {
  it('evicts the least recently used idle entry when a new session needs the slot', async () => {
    const browsers: FakeBrowser[] = [];
    connectOverCDPMock.mockImplementation(async () => {
      const b = fakeBrowser();
      browsers.push(b);
      return b;
    });
    for (let i = 0; i < CDP_POOL_CAP; i++) {
      await withPooledBrowser('steel', `s${i}`, 't1', async () => undefined);
    }
    expect(_cdpPoolEntries().size).toBe(CDP_POOL_CAP);
    // Touch s0 so s1 is the oldest.
    await withPooledBrowser('steel', 's0', 't1', async () => undefined);
    await withPooledBrowser('steel', 'new', 't1', async () => undefined);
    expect(_cdpPoolEntries().size).toBe(CDP_POOL_CAP);
    expect(_cdpPoolEntries().has('steel:s1')).toBe(false);
    expect(_cdpPoolEntries().has('steel:s0')).toBe(true);
    expect(browsers[1].close).toHaveBeenCalled();
  });
});

describe('dropConnection', () => {
  it('closes the connection before the vendor is told, and is a no-op for a session with none', async () => {
    const browser = fakeBrowser();
    connectOverCDPMock.mockResolvedValue(browser);
    await withPooledBrowser('steel', 's1', 't1', async () => undefined);
    const order: string[] = [];
    browser.close.mockImplementation(async () => { order.push('drop'); browser.connected = false; });
    await dropConnection('steel', 's1');
    order.push('vendor');
    expect(order).toEqual(['drop', 'vendor']);
    expect(_cdpPoolEntries().has('steel:s1')).toBe(false);
    await expect(dropConnection('steel', 'never')).resolves.toBeUndefined();
  });
});

// Downloads, heard where every vendor has to announce them
//
// A download used to be a vendor feature: the one browser with a download API
// answered a listing endpoint and the other three refused, while the pane runs
// one of the three by default. Chromium announces a download on the browser's
// own CDP session before it writes anything, which is the same connection
// every pane operation already shares, so the announcement is heard whoever
// is hosting the browser.
describe('hearing a download', () => {
  /** A browser that answers a browser-level CDP session, as Chromium does. */
  function browserWithCdp(): FakeBrowser & { cdpListeners: Map<string, Listener[]>; sent: unknown[] } {
    const b = fakeBrowser() as FakeBrowser & {
      cdpListeners: Map<string, Listener[]>;
      sent: unknown[];
      newBrowserCDPSession: () => Promise<unknown>;
    };
    b.cdpListeners = new Map();
    b.sent = [];
    b.newBrowserCDPSession = async () => ({
      on: (event: string, fn: Listener) => { b.cdpListeners.set(event, [...(b.cdpListeners.get(event) ?? []), fn]); },
      send: async (method: string, params: unknown) => { b.sent.push({ method, params }); },
    });
    return b;
  }

  /** The fire-and-forget arming runs after the operation answers. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('arms on the session\'s own connection and records what the browser announced', async () => {
    jest.useRealTimers();
    const browser = browserWithCdp();
    connectOverCDPMock.mockResolvedValue(browser);
    await withPooledBrowser('steel', 's1', 't1', async () => undefined);
    await settle();

    expect(_downloadsArmedFor('steel', 's1')).toBe(true);
    // The browser's own handling is left alone; only the events are turned on.
    expect(browser.sent).toEqual([{
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'default', eventsEnabled: true },
    }]);

    for (const fn of browser.cdpListeners.get('Browser.downloadWillBegin') ?? []) {
      fn({ url: 'https://cdn.example/clip.mp4', suggestedFilename: 'clip.mp4' });
    }
    await settle();
    expect(recordDownloadMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', sessionId: 'row-s1', url: 'https://cdn.example/clip.mp4', suggestedFileName: 'clip.mp4',
    }));
    // A file the page built in the browser exists only for this moment, so
    // the attempt to take it is made on every announcement; which addresses
    // are worth taking is the taker's decision, not this one's.
    expect(keepDownloadBytesMock).toHaveBeenCalledWith('steel', 's1', 't1', 'https://cdn.example/clip.mp4');
  });

  it('arms once per connection, however many operations run', async () => {
    jest.useRealTimers();
    const browser = browserWithCdp();
    connectOverCDPMock.mockResolvedValue(browser);
    await withPooledBrowser('browserbase', 's2', 't1', async () => undefined);
    await settle();
    await withPooledBrowser('browserbase', 's2', 't1', async () => undefined);
    await settle();
    expect(browser.sent).toHaveLength(1);
  });

  it('listens per context when the browser refuses a browser-level session, rather than hearing nothing', async () => {
    jest.useRealTimers();
    const browser = fakeBrowser() as FakeBrowser & { newBrowserCDPSession: () => Promise<unknown> };
    const contextListeners: Listener[] = [];
    browser.contexts = () => [{
      pages: () => [{ url: () => 'https://maker.example/studio' }],
      on: (_event: string, fn: Listener) => { contextListeners.push(fn); },
    }] as never;
    browser.newBrowserCDPSession = async () => { throw new Error('not supported'); };
    connectOverCDPMock.mockResolvedValue(browser);
    await withPooledBrowser('browser-use', 's3', 't1', async () => undefined);
    await settle();

    expect(contextListeners).toHaveLength(1);
    contextListeners[0]({ url: () => 'https://cdn.example/export.csv', suggestedFilename: () => 'export.csv' });
    await settle();
    expect(recordDownloadMock).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://cdn.example/export.csv',
      suggestedFileName: 'export.csv',
      originUrl: 'https://maker.example/studio',
    }));
  });

  it('a session that is closed, or another workspace\'s, is not armed', async () => {
    jest.useRealTimers();
    getByVendorSessionIdMock.mockResolvedValueOnce({ id: 'row-s4', tenantId: 't1', closedAt: new Date() } as never);
    const browser = browserWithCdp();
    connectOverCDPMock.mockResolvedValue(browser);
    await withPooledBrowser('anchor', 's4', 't1', async () => undefined);
    await settle();
    expect(_downloadsArmedFor('anchor', 's4')).toBe(false);
    expect(browser.sent).toHaveLength(0);
  });
});
