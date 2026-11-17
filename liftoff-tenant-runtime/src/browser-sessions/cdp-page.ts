// One pooled CDP connection per browser session, for every pane operation.
//
// Every pane operation used to open its own `connectOverCDP` (steel-client,
// browserbase-client, browser-use-client, each with the same `withPage`),
// 0.5 to 1 s per call to a remote endpoint, and a `/pause` that attached the
// recorder on a fresh connection took several seconds. The
// connection is now kept, per process, keyed `${vendor}:${vendorSessionId}`:
// a hit whose browser is still connected is reused, a miss connects once and
// concurrent first callers share that one connect, and a `disconnected`
// event evicts the entry.
//
// ONLY A CONNECT IS RETRIED. The stored endpoint (our row) is tried first
// and the vendor is asked for a fresh one when it does not connect, exactly
// the fallback the three clients carried, and it happens BEFORE the
// operation. A disconnect during an operation fails that operation and
// evicts the entry, and nothing replays it, because a click may have landed
// before the socket died.
//
// A connection idles out after CDP_IDLE_CLOSE_MS with nothing in flight and
// no session capture holding it (takeover-capture/session-capture.ts keeps
// the recorder attached for the session's lifetime on this same
// connection); the pool is capped at CDP_POOL_CAP entries with the least
// recently used idle one evicted first. `dropConnection` is called from the
// session's close, before the vendor is told, and from the reaper.
//
// Cloud Run note: the pool is per instance. A request that lands on another
// instance connects its own; both are correct, only slower. Nothing here is
// shared across instances and nothing needs to be.
//
// The three CDP clients keep their methods and their `withPage` signature as
// delegations to `withPage` here; each keeps its own `cdpUrlFor` behind
// `cdpEndpointFor(..., { fresh: true })`. `restorePaneViewport` and
// `PANE_DIMENSIONS` moved here from steel-client, where the pane's viewport
// was first restored after a hand-back collapsed it.

import { chromium, type Browser, type Page } from 'playwright-core';
import { getPool } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { PhaseTimer } from './cdp-endpoint';

/** Close a connection nothing has used for this long, unless a session
 *  capture holds it. */
export const CDP_IDLE_CLOSE_MS = 60_000;

/** Connections kept per process, at most; the least recently used idle one
 *  goes when a new session needs the slot. */
export const CDP_POOL_CAP = 200;

/** The pane's default viewport; the live view scales to its container. A
 *  session whose pane reported its size (SetViewport) stores that on the
 *  row instead, and the restore below prefers it. */
export const PANE_DIMENSIONS = { width: 1280, height: 800 } as const;

export interface Viewport {
  width: number;
  height: number;
}

interface PoolEntry {
  key: string;
  vendor: string;
  vendorSessionId: string;
  tenantId: string;
  browser: Browser | null;
  /** The connect in flight, shared by every caller that arrives during it. */
  connecting: Promise<Browser> | null;
  /** Recency, as a counter rather than a clock: two uses in the same
   *  millisecond still order, which is what the LRU eviction reads. */
  lastUsedAt: number;
  inFlight: number;
  /** Session captures holding this connection open past the idle window. */
  holds: number;
  idleTimer: NodeJS.Timeout | null;
  /** The endpoint this browser connected through; the fallback is skipped
   *  when a fresh one was already used. */
  connectedThrough: 'stored' | 'vendor' | null;
}

const pool = new Map<string, PoolEntry>();

let useCounter = 0;
function touched(): number {
  useCounter += 1;
  return useCounter;
}

export function poolKeyFor(vendor: string, vendorSessionId: string): string {
  return `${vendor}:${vendorSessionId}`;
}

/** The vendor's endpoint lookup, reached dynamically: the proxy imports the
 *  clients, which import this module. */
async function endpointFor(vendor: string, vendorSessionId: string, tenantId: string, fresh: boolean): Promise<string> {
  const { cdpEndpointFor } = await import('./session-vendor-proxy');
  return cdpEndpointFor(vendor, vendorSessionId, tenantId, { fresh });
}

/** Connect, stored endpoint first, vendor on a miss. This is the ONE retry
 *  in the module, and it happens before any operation. */
async function connect(entry: PoolEntry, timer: PhaseTimer): Promise<Browser> {
  const stored = await endpointFor(entry.vendor, entry.vendorSessionId, entry.tenantId, false);
  timer.mark('cdp_url');
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(stored);
    entry.connectedThrough = 'stored';
  } catch (err) {
    logger.warn(
      { vendor: entry.vendor, vendor_session_id: entry.vendorSessionId, err: (err as Error).message },
      'stored cdp endpoint did not connect; refetching from the vendor',
    );
    const fresh = await endpointFor(entry.vendor, entry.vendorSessionId, entry.tenantId, true);
    if (fresh === stored) throw err;
    browser = await chromium.connectOverCDP(fresh);
    entry.connectedThrough = 'vendor';
  }
  timer.mark('connect');
  browser.on('disconnected', () => {
    // The browser went away under us: a vendor timeout, a session close, a
    // network fault. Evict, and let the next operation connect anew.
    const current = pool.get(entry.key);
    if (current && current.browser === browser) {
      clearIdle(current);
      pool.delete(entry.key);
      logger.info({ vendor: entry.vendor, vendor_session_id: entry.vendorSessionId, event: 'cdp_pool_disconnected' },
        'pooled cdp connection disconnected; evicted');
    }
  });
  return browser;
}

function clearIdle(entry: PoolEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

/** Arm the idle close for an entry nothing is using and nothing holds. */
function scheduleIdle(entry: PoolEntry): void {
  clearIdle(entry);
  if (entry.inFlight > 0 || entry.holds > 0) return;
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    if (entry.inFlight > 0 || entry.holds > 0) return;
    if (pool.get(entry.key) !== entry) return;
    void closeEntry(entry, 'idle');
  }, CDP_IDLE_CLOSE_MS);
  entry.idleTimer.unref?.();
}

async function closeEntry(entry: PoolEntry, why: string): Promise<void> {
  clearIdle(entry);
  if (pool.get(entry.key) === entry) pool.delete(entry.key);
  const browser = entry.browser;
  entry.browser = null;
  downloadsArmed.delete(entry.key);
  if (browser) {
    // Disconnects our client only; the vendor's session, and the pane the
    // person is watching, stay up.
    await browser.close().catch(() => undefined);
  }
  logger.info({ vendor: entry.vendor, vendor_session_id: entry.vendorSessionId, why, event: 'cdp_pool_closed' },
    'pooled cdp connection closed');
}

/** Make room under the cap: the least recently used entry with nothing in
 *  flight and no hold goes. Chosen synchronously, so two first callers that
 *  arrive together see the same pool; when every entry is busy, nothing is
 *  evicted and the pool grows past the cap for the moment. */
function evictForRoom(keep: PoolEntry): void {
  if (pool.size <= CDP_POOL_CAP) return;
  let victim: PoolEntry | null = null;
  for (const entry of pool.values()) {
    if (entry === keep || entry.inFlight > 0 || entry.holds > 0 || entry.connecting) continue;
    if (!victim || entry.lastUsedAt < victim.lastUsedAt) victim = entry;
  }
  if (victim) void closeEntry(victim, 'cap');
}

async function acquire(vendor: string, vendorSessionId: string, tenantId: string, timer: PhaseTimer): Promise<{ entry: PoolEntry; browser: Browser; pooled: boolean }> {
  const key = poolKeyFor(vendor, vendorSessionId);
  let entry = pool.get(key);
  if (entry && entry.tenantId !== tenantId) {
    // A session is one tenant's. A second tenant naming the same vendor
    // session id is refused rather than handed the connection.
    throw new Error(`cdp connection for ${key} belongs to another tenant`);
  }
  if (entry?.browser && entry.browser.isConnected()) {
    entry.lastUsedAt = touched();
    return { entry, browser: entry.browser, pooled: true };
  }
  if (entry?.connecting) {
    const browser = await entry.connecting;
    entry.lastUsedAt = touched();
    return { entry, browser, pooled: true };
  }
  if (!entry) {
    // Registered BEFORE the first await, so a second caller arriving during
    // the connect finds the entry and shares it rather than connecting too.
    entry = {
      key, vendor, vendorSessionId, tenantId,
      browser: null, connecting: null, lastUsedAt: touched(), inFlight: 0, holds: 0, idleTimer: null,
      connectedThrough: null,
    };
    pool.set(key, entry);
    evictForRoom(entry);
  }
  const current = entry;
  current.connecting = connect(current, timer).then((browser) => {
    current.browser = browser;
    current.connecting = null;
    return browser;
  }, (err) => {
    current.connecting = null;
    if (pool.get(key) === current && !current.browser) pool.delete(key);
    throw err;
  });
  const browser = await current.connecting;
  current.lastUsedAt = touched();
  return { entry: current, browser, pooled: false };
}

/**
 * Run one operation against the session's pooled browser. The connection is
 * reused across calls; the operation is never retried.
 */
export async function withPooledBrowser<T>(
  vendor: string,
  vendorSessionId: string,
  tenantId: string,
  fn: (browser: Browser) => Promise<T>,
  opName = 'withPooledBrowser',
): Promise<T> {
  const timer = new PhaseTimer();
  const { entry, browser, pooled } = await acquire(vendor, vendorSessionId, tenantId, timer);
  entry.inFlight += 1;
  clearIdle(entry);
  // BEFORE the operation, not after it.
  //
  // This used to run in the finally below, which left the FIRST operation on
  // every fresh connection unarmed — and the first operation is routinely the
  // one that starts a download, because opening the session and clicking the
  // page's download control is the whole job. A file the page builds can only
  // be held onto before it is built, so arming afterwards is arming too late.
  //
  // Awaited, because arming after the click is the defect. It is one CDP call
  // and one init script, once per connection.
  await armDownloads(entry).catch(() => undefined);
  try {
    const out = await fn(browser);
    timer.mark('operation');
    return out;
  } finally {
    entry.inFlight -= 1;
    entry.lastUsedAt = touched();
    scheduleIdle(entry);
    timer.log('cdp_operation', {
      vendor, op: opName, vendor_session_id: vendorSessionId,
      pooled,
      cdp_url_from_store: entry.connectedThrough === 'stored',
    });
    for (const listener of activityListeners) {
      try { listener(entry.key); } catch { /* a listener's failure is its own */ }
    }
    void warmOnFirstUse(entry);
  }
}

/** Activity listeners: a pane operation on a session counts as activity for
 *  whoever keeps an idle rule of their own (the session capture). */
const activityListeners = new Set<(key: string) => void>();

export function onPoolActivity(listener: (key: string) => void): () => void {
  activityListeners.add(listener);
  return () => { activityListeners.delete(listener); };
}

/**
 * Run one operation against the session's page. Same page choice the three
 * clients made: the context's first page, else a new one.
 */
export async function withPage<T>(
  vendor: string,
  vendorSessionId: string,
  tenantId: string,
  fn: (page: Page) => Promise<T>,
  opName = 'withPage',
): Promise<T> {
  return withPooledBrowser(vendor, vendorSessionId, tenantId, async (browser) => {
    const ctx = browser.contexts()[0] ?? await browser.newContext();
    const page = ctx.pages()[0] ?? await ctx.newPage();
    return fn(page);
  }, opName);
}

/** Keep the connection open past the idle window (a session capture).
 *  Returns the release. */
export function holdConnection(vendor: string, vendorSessionId: string): () => void {
  const entry = pool.get(poolKeyFor(vendor, vendorSessionId));
  if (!entry) return () => undefined;
  entry.holds += 1;
  clearIdle(entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.holds = Math.max(0, entry.holds - 1);
    scheduleIdle(entry);
  };
}

/** Drop the session's connection: from the session's close (before the
 *  vendor is told), from a run's end, and from the reaper. A session with
 *  no connection is a no-op. */
export async function dropConnection(vendor: string, vendorSessionId: string): Promise<void> {
  const entry = pool.get(poolKeyFor(vendor, vendorSessionId));
  if (!entry) return;
  if (entry.connecting) {
    await entry.connecting.catch(() => undefined);
  }
  await closeEntry(entry, 'dropped');
}

// ── The recorder warmed on the first pane operation ─────────────────────────

/** Sessions this process has already tried to warm a capture on. */
const warmAttempted = new Set<string>();

/** The first pane operation on a session without a warm capture starts one,
 *  fire-and-forget: the recorder is then attached before the person's first
 *  takeover, and `/pause` takes the fast path. Reached dynamically for the
 *  import order's sake (session-capture imports the capture index, which
 *  imports the vendor proxy, which imports the clients, which import this). */
async function warmOnFirstUse(entry: PoolEntry): Promise<void> {
  if (warmAttempted.has(entry.key)) return;
  warmAttempted.add(entry.key);
  try {
    const { hasWarmSessionCapture, warmSessionCapture } = await import('./takeover-capture/session-capture');
    const repo = await import('./repository');
    const session = await repo.getByVendorSessionId(entry.vendorSessionId);
    if (!session || session.closedAt || session.tenantId !== entry.tenantId) return;
    if (hasWarmSessionCapture(session.id)) return;
    await warmSessionCapture({ tenantId: entry.tenantId, session });
  } catch (err) {
    logger.warn({ vendor: entry.vendor, vendor_session_id: entry.vendorSessionId, err: (err as Error).message },
      'cdp pool: could not warm the session capture on first use');
  }
}

/** For tests: forget which sessions were warmed. */
export function _resetWarmAttempts(): void {
  warmAttempted.clear();
}

// ── Downloads, heard on the session's own connection ──────────────────

/** The browser each session's download capture is armed on. A reconnect
 *  brings a different Browser and is armed again; a closed entry is
 *  forgotten. */
const downloadsArmed = new Map<string, Browser>();

/** How many of a page's built files to hold onto, and how much in total. A
 *  generator makes one file at a time; the cap is for a page that makes
 *  hundreds, so holding them cannot grow without bound. */
const BLOBS_HELD = 8;
const BLOBS_HELD_BYTES = 64 * 1024 * 1024;

/**
 * Stop a page from throwing away a file it just made.
 *
 * A generator builds the file in the browser, hands it to a click under a
 * `blob:` address, and revokes that address in the same tick. Reading it
 * afterwards is a race against the page, and the page wins: the announcement
 * arrives, a CDP connection is opened to go and read it, and by then the
 * address resolves to nothing. That race was lost every single time.
 *
 * So the race is removed instead of run. `URL.createObjectURL` keeps what it
 * was given, and `revokeObjectURL` stops being the end of it: the address goes
 * dead for the page, exactly as the page intends, while the file itself stays
 * reachable through a handle of ours. The oldest are let go of properly once
 * the cap is reached, so a long session cannot grow without bound.
 *
 * Armed on every document, because the download can happen on any page of the
 * session and a file is only rescuable before it is built.
 */
async function holdOntoBlobs(browser: Browser, entry: PoolEntry): Promise<void> {
  const script = `(() => {
    if (window.__liftoffHeldBlobs) return;
    const held = new Map();
    let bytes = 0;
    const realCreate = URL.createObjectURL.bind(URL);
    const realRevoke = URL.revokeObjectURL.bind(URL);
    const letGo = (url) => {
      const b = held.get(url);
      if (!b) return;
      held.delete(url);
      bytes -= (b.size || 0);
      try { realRevoke(url); } catch (e) { /* already gone */ }
    };
    URL.createObjectURL = function (obj) {
      const url = realCreate(obj);
      try {
        if (obj && typeof obj.size === 'number') {
          held.set(url, obj);
          bytes += obj.size;
          while (held.size > ${BLOBS_HELD} || bytes > ${BLOBS_HELD_BYTES}) {
            const oldest = held.keys().next();
            if (oldest.done) break;
            letGo(oldest.value);
          }
        }
      } catch (e) { /* holding on is best effort */ }
      return url;
    };
    // The page's revoke is honoured for the page — the address stops working
    // where it asked — and the file stays ours to read.
    URL.revokeObjectURL = function (url) {
      if (!held.has(url)) { realRevoke(url); return; }
      try { realRevoke(url); } catch (e) { /* already gone */ }
    };
    window.__liftoffHeldBlobs = held;
    window.__liftoffTakeHeldBlob = (url) => new Promise((resolve) => {
      const b = held.get(url);
      if (!b) { resolve(null); return; }
      const r = new FileReader();
      r.onload = () => resolve({ base64: String(r.result).split(',')[1] || '', contentType: b.type || '' });
      r.onerror = () => resolve(null);
      r.readAsDataURL(b);
    });
  })();`;
  for (const ctx of browser.contexts()) {
    try {
      await ctx.addInitScript(script);
      // The documents already open were loaded before the script existed, so
      // they get it directly; a generator page is usually one of these.
      for (const page of ctx.pages()) {
        await page.evaluate(script).catch(() => undefined);
      }
    } catch (err) {
      logger.warn(
        { vendor: entry.vendor, vendor_session_id: entry.vendorSessionId, err: (err as Error).message },
        'could not arm holding onto files the page builds; a generated file may be revoked before it can be taken',
      );
    }
  }
}

/**
 * Hear every download this session starts, whichever vendor's browser the
 * connection reached.
 *
 * Chromium announces a download on the browser's own CDP session before it
 * has written anything, with the address it is fetching and the name it
 * would save. That announcement is the whole record (see
 * `browser-sessions/downloads.ts`): the bytes are fetched from inside the
 * page when somebody asks for the file, so this neither changes what the
 * browser does with the download nor depends on a vendor's file store, and
 * the one capability that was Anchor's alone works on all four.
 *
 * `behavior: 'default'` says exactly that: leave the browser's own handling
 * alone, and turn the events on.
 */
async function armDownloads(entry: PoolEntry): Promise<void> {
  const browser = entry.browser;
  if (!browser || !browser.isConnected()) return;
  if (downloadsArmed.get(entry.key) === browser) return;
  downloadsArmed.set(entry.key, browser);
  try {
    const repo = await import('./repository');
    const session = await repo.getByVendorSessionId(entry.vendorSessionId);
    if (!session || session.closedAt || session.tenantId !== entry.tenantId) {
      downloadsArmed.delete(entry.key);
      return;
    }
    await holdOntoBlobs(browser, entry);
    const { recordDownload, keepDownloadBytes } = await import('./downloads');
    const remember = (url: string, suggestedFileName: string): void => {
      if (!url) return;
      const originUrl = browser.contexts()[0]?.pages()[0]?.url() ?? '';
      // A file the page built in the browser exists only for this moment:
      // the address it was handed under is revoked as soon as the click is
      // done, so the bytes are taken now or not at all. Started before the
      // record is written, because the race is with the page, not with us.
      void keepDownloadBytes(entry.vendor, entry.vendorSessionId, entry.tenantId, url);
      void recordDownload({
        tenantId: entry.tenantId, sessionId: session.id, url, suggestedFileName, originUrl,
      }).then(() => {
        logger.info(
          { vendor: entry.vendor, vendor_session_id: entry.vendorSessionId, event: 'browser_download_seen' },
          'the session started a download',
        );
      }).catch((err) => {
        logger.warn(
          { vendor: entry.vendor, vendor_session_id: entry.vendorSessionId, err: (err as Error).message },
          'could not record a browser download',
        );
      });
    };
    try {
      const cdp = await browser.newBrowserCDPSession();
      cdp.on('Browser.downloadWillBegin', (event) => {
        const e = event as { url?: string; suggestedFilename?: string };
        remember(e.url ?? '', e.suggestedFilename ?? '');
      });
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
    } catch (err) {
      // A browser that refuses a browser-level CDP session still raises
      // Playwright's own per-context event. That covers the contexts open
      // now, which is the pane's, rather than every context the session may
      // later open: less, and better than nothing.
      logger.warn(
        { vendor: entry.vendor, vendor_session_id: entry.vendorSessionId, err: (err as Error).message },
        'browser-level download events unavailable; listening per context',
      );
      for (const ctx of browser.contexts()) {
        ctx.on('download', (download) => remember(download.url(), download.suggestedFilename()));
      }
    }
  } catch (err) {
    downloadsArmed.delete(entry.key);
    logger.warn(
      { vendor: entry.vendor, vendor_session_id: entry.vendorSessionId, err: (err as Error).message },
      'could not arm download capture for the session',
    );
  }
}

/** For tests: whether a session's download capture is armed. */
export function _downloadsArmedFor(vendor: string, vendorSessionId: string): boolean {
  return downloadsArmed.has(poolKeyFor(vendor, vendorSessionId));
}

// ── The pane viewport ────────────────────────────────────────────────────────

/** The viewport the pane reported for a session, from the row, or null. */
export async function storedViewport(vendorSessionId: string): Promise<Viewport | null> {
  try {
    const { rows } = await getPool().query<{ viewport: unknown }>(
      `SELECT vendor_metadata->'viewport' AS viewport
         FROM web_sessions
        WHERE vendor_session_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [vendorSessionId],
    );
    const v = rows[0]?.viewport as { width?: unknown; height?: unknown } | null | undefined;
    if (!v || typeof v.width !== 'number' || typeof v.height !== 'number') return null;
    return { width: v.width, height: v.height };
  } catch (err) {
    logger.warn({ err: (err as Error).message, vendor_session_id: vendorSessionId },
      'stored viewport lookup failed; using the pane default');
    return null;
  }
}

/** A page whose layout viewport has collapsed to nothing (seen after the
 *  interactive live view disconnected on a person's hand-back: `Cannot take
 *  screenshot with 0 width`) is put back at the pane's size before anything
 *  is rendered from it: the size the pane last reported when it did, else
 *  the default. A page with a real viewport is left alone. */
export async function restorePaneViewport(page: Page, vendorSessionId?: string): Promise<void> {
  // Evaluated in the page, where `window` exists; the string form keeps this
  // file's own (Node) type checking honest.
  const size = await page.evaluate<{ width: number; height: number }>(
    '({ width: window.innerWidth, height: window.innerHeight })',
  ).catch(() => null);
  if (size && size.width > 0 && size.height > 0) return;
  const stored = vendorSessionId ? await storedViewport(vendorSessionId) : null;
  await page.setViewportSize(stored ?? { ...PANE_DIMENSIONS });
}

// ── For tests ────────────────────────────────────────────────────────────────

/** For tests: the pool's entries, as facts. */
export function _cdpPoolEntries(): ReadonlyMap<string, { tenantId: string; connected: boolean; inFlight: number; holds: number; connecting: boolean }> {
  return new Map([...pool.entries()].map(([key, e]) => [key, {
    tenantId: e.tenantId, connected: !!e.browser && e.browser.isConnected(), inFlight: e.inFlight, holds: e.holds, connecting: e.connecting !== null,
  }]));
}

/** For tests: close every connection and forget it. */
export async function _closeCdpPool(): Promise<void> {
  await Promise.all([...pool.values()].map((e) => closeEntry(e, 'test')));
  pool.clear();
  warmAttempted.clear();
  downloadsArmed.clear();
}
