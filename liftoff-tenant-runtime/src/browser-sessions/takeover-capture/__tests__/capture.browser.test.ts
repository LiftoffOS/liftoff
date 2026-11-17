// Takeover capture against a real Chromium, driven over CDP exactly as the
// runtime drives a vendor's session.
//
// jsdom cannot show any of this: whether a trusted click is recorded and a
// synthetic one is not, whether page code can reach the recorder's binding,
// what an attach against a closed port does to the lease, what a browser
// killed mid-hold does to it, whether a cross-site iframe is covered through
// its own target, whether 501 clicks yield exactly 500 rows and a `cap` gap,
// and the one documented limit — a page listener registered before the
// recorder attached can hide a click, and `capture_gap = false` does not
// claim otherwise.
//
// Since 424 the recorder also carries what was entered, except protected
// data, and the non-textual interactions the five-kind recorder missed; a
// call-scoped TaskCapture observes an in-session agent task the same way.
// Those are proven here too: values on change, Enter and a contenteditable
// blur; multi-select, checkbox, key, positioned scroll, drag, hover, context
// menu and coordinate detail; every protected class, whole-auth-form and
// payment-field-only suppression; URL ids, filters and SPA fragments
// surviving while reset tokens and signed parameters do not; truncation
// flags; the Enter/change dedupe; the partial-attachment gap; and a fake
// Anchor-shaped and Stagehand-shaped task driven over CDP, whose generated
// input events reach the isolated-world listener as trusted events.
//
// The classifier's limit is stated rather than oversold: it follows the
// page's labels, types, autocomplete tokens, form membership and route, so a
// secret typed into a mislabelled field on a page that declares nothing is
// recorded as an ordinary value, and the credential redactor on the Node
// side is the second layer. No test here claims otherwise.
//
// The recorder's repository is an in-memory fake with the lease semantics of
// the real one (repository.ts): the real statements are held to their shape
// in lease.test.ts, and the migration is applied from scratch in CI. Runs
// under jest.browser.config.js; see that file for the CI image.

import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../session-vendor-proxy', () => ({ cdpEndpointFor: jest.fn() }));

// ── The in-memory repository: the lease and the cap, as the SQL has them ─────

interface HoldState {
  id: string;
  tenantId: string;
  endedAt: Date | null;
  captureOwner: string | null;
  captureGeneration: number;
  captureLeaseUntil: Date | null;
  captureGap: boolean;
  gapReason: string | null;
}
interface ActionRowState {
  holdId: string; generation: number; nonce: string; seq: number; kind: string; url: string;
  urlTruncated: boolean; urlProtectedDataOmitted: boolean;
  tag: string | null; role: string | null; name: string | null; nameTruncated: boolean; nameProtectedDataOmitted: boolean;
  inputType: string | null; value: string | null; valueTruncated: boolean; valueDisposition: string;
  detail: string | null; detailTruncated: boolean; detailProtectedDataOmitted: boolean; at: Date;
}

const mockStore = {
  holds: new Map<string, HoldState>(),
  actions: [] as ActionRowState[],
  /** The FOR UPDATE row lock, as a per-hold async mutex. */
  locks: new Map<string, Promise<void>>(),
  async withLock<T>(holdId: string, fn: () => Promise<T>): Promise<T> {
    const prev = mockStore.locks.get(holdId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    mockStore.locks.set(holdId, prev.then(() => mine));
    await prev;
    try { return await fn(); } finally { release(); }
  },
  reset() { mockStore.holds.clear(); mockStore.actions = []; mockStore.locks.clear(); },
  newHold(id: string): HoldState {
    const h: HoldState = { id, tenantId: 't', endedAt: null, captureOwner: null, captureGeneration: 0, captureLeaseUntil: null, captureGap: false, gapReason: null };
    mockStore.holds.set(id, h);
    return h;
  },
  actionsFor(holdId: string) { return mockStore.actions.filter((a) => a.holdId === holdId); },
};

jest.mock('../repository', () => ({
  claimCapture: async (_tenant: string, holdId: string, owner: string) => mockStore.withLock(holdId, async () => {
    const h = mockStore.holds.get(holdId);
    if (!h || h.endedAt) return null;
    if (h.captureOwner !== null && h.captureLeaseUntil !== null && h.captureLeaseUntil.getTime() >= Date.now()) return null;
    const prev = h.captureGeneration;
    h.captureOwner = owner;
    h.captureGeneration = prev + 1;
    h.captureLeaseUntil = new Date(Date.now() + 60_000);
    h.captureGap = h.captureGap || prev > 0;
    h.gapReason = h.gapReason ?? (prev > 0 ? 'lost_owner' : null);
    return h.captureGeneration;
  }),
  renewCapture: async (_t: string, holdId: string, owner: string, generation: number) => {
    const h = mockStore.holds.get(holdId);
    if (!h || h.endedAt || h.captureOwner !== owner || h.captureGeneration !== generation) return false;
    h.captureLeaseUntil = new Date(Date.now() + 60_000);
    return true;
  },
  releaseCapture: async (_t: string, holdId: string, owner: string, generation: number, reason: string) => {
    const h = mockStore.holds.get(holdId);
    // Only an OPEN hold, as the real statement has it.
    if (!h || h.endedAt || h.captureOwner !== owner || h.captureGeneration !== generation) return;
    h.captureOwner = null; h.captureLeaseUntil = null; h.captureGap = true; h.gapReason = h.gapReason ?? reason;
  },
  markCaptureGap: async (_t: string, holdId: string, reason: string) => {
    const h = mockStore.holds.get(holdId);
    if (h) { h.captureGap = true; h.gapReason = h.gapReason ?? reason; }
  },
  insertAction: async (tenantId: string, holdId: string, owner: string, generation: number, a: Omit<ActionRowState, 'holdId' | 'generation' | 'at'>) =>
    mockStore.withLock(holdId, async () => {
      const h = mockStore.holds.get(holdId);
      if (!h || h.endedAt || h.captureOwner !== owner || h.captureGeneration !== generation) return 'stale';
      if (mockStore.actionsFor(holdId).length >= 500) {
        h.captureGap = true; h.gapReason = h.gapReason ?? 'cap';
        return 'capped';
      }
      if (mockStore.actions.some((x) => x.holdId === holdId && x.nonce === a.nonce && x.seq === a.seq)) return 'duplicate';
      mockStore.actions.push({ holdId, generation, ...a, at: new Date() });
      void tenantId;
      return 'inserted';
    }),
}));

import {
  ensureTakeoverCapture, _detachAllTakeoverCaptures, _activeTakeoverCaptures, CAPTURE_OWNER,
  TaskCapture, withoutTakeoverIntervals, type ObservedAction,
} from '../index';
import { observedStepsFrom, reconcileTrail } from '../observed-steps';
import { projectStagehandSteps } from '../../../integrations/web-fetch/step-policy';
import { TAKEOVER_BINDING } from '../recorder';

// ── Fixture pages ───────────────────────────────────────────────────────────

function pageHtml(body: string, head = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

const PAGES: Record<string, (host: string, port: number) => string> = {
  '/signin': () => pageHtml(`
    <button id="signin"><span>Sign in</span></button>
    <form id="f" onsubmit="event.preventDefault()">
      <label for="pw">Password</label><input id="pw" type="password">
      <label for="code">Enter the code XYZ-SECRET-CODE here</label><input id="code">
      <button id="cont" type="button">Continue as jane@example.com</button>
    </form>`),
  '/hostile': () => pageHtml(`<button id="signin"><span>Sign in</span></button>`, `<script>
    // Page code trying to see or fake the recorder, before and after load.
    window.__seen = [];
    function wrapAll() {
      var b = window['${TAKEOVER_BINDING}'];
      if (typeof b === 'function') { window['${TAKEOVER_BINDING}'] = function (p) { window.__seen.push(p); return b(p); }; }
      JSON.stringify = function () { window.__seen.push('stringify'); return '{}'; };
      Object.defineProperty(Event.prototype, 'isTrusted', { get: function () { return true; }, configurable: true });
      var add = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (t, fn, o) { window.__seen.push('add:' + t); return add.call(this, t, fn, o); };
    }
    wrapAll();
    window.addEventListener('load', wrapAll);
    window.__wrapAgain = wrapAll;
  </script>`),
  '/orders/3f2a91b8c07d4e65/edit': () => pageHtml('<h1>Order</h1>'),
  '/orders/pending/edit': () => pageHtml('<h1>Pending</h1>'),
  '/frame-parent': (host, port) => pageHtml(`<h1>Parent</h1><iframe id="fr" src="http://${host}:${port}/frame-child" width="400" height="200"></iframe>`),
  '/frame-child': () => pageHtml('<button id="child"><span>Child button</span></button>'),
  '/many': () => pageHtml('<button id="many" style="width:200px;height:100px">Again</button>'),
  '/issues': () => pageHtml(`
    <form id="search" onsubmit="event.preventDefault(); history.pushState({}, '', '/issues?q=' + encodeURIComponent(document.getElementById('q').value) + '#results')">
      <label for="q">Search all issues</label><input id="q" name="q" type="text">
      <label for="status">Status</label>
      <select id="status" name="status" multiple><option>Open</option><option>Closed</option><option>Draft</option></select>
      <label><input id="archived" name="archived" type="checkbox"> Include archived</label>
      <button id="go" type="submit">Search</button>
    </form>
    <div id="notes" contenteditable="true" aria-label="Notes" style="min-height:40px;border:1px solid #999"></div>
    <ul id="board" style="display:flex;gap:20px">
      <li id="card" draggable="true" role="listitem" style="width:120px;height:60px;background:#ddd">Card 4</li>
      <li id="done" role="listitem" style="width:120px;height:60px;background:#eee">Done</li>
    </ul>
    <canvas id="chart" width="200" height="100" style="display:block"></canvas>
    <a id="commits" href="/issues#commits">Commits</a>
    <div id="tall" style="height:3000px"></div>
    <script>
      document.getElementById('board').addEventListener('dragover', function (e) { e.preventDefault(); });
      document.getElementById('done').addEventListener('dragover', function (e) { e.preventDefault(); });
      document.getElementById('done').addEventListener('drop', function (e) { e.preventDefault(); });
    </script>`),
  '/login': () => pageHtml(`
    <form id="f" onsubmit="event.preventDefault()">
      <label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username">
      <label for="pw">Password</label><input id="pw" name="password" type="password">
      <label><input id="remember" type="checkbox"> Remember me</label>
      <button id="submit" type="submit">Sign in</button>
    </form>`),
  '/checkout': () => pageHtml(`
    <form id="pay" onsubmit="event.preventDefault()">
      <label for="cardname">Name on card</label><input id="cardname" autocomplete="cc-name">
      <label for="cardnum">Card number</label><input id="cardnum" autocomplete="cc-number" inputmode="numeric">
      <label for="cvv">CVV</label><input id="cvv" autocomplete="cc-csc">
      <label for="street">Street address</label><input id="street" autocomplete="street-address">
      <label for="city">City</label><input id="city">
      <label for="promo">Promo code</label><input id="promo">
    </form>`),
  '/onboarding': () => pageHtml(`
    <form id="hr" onsubmit="event.preventDefault()">
      <label for="ssn">Social security number</label><input id="ssn">
      <label for="dob">Date of birth</label><input id="dob" placeholder="DD/MM/YYYY">
      <label for="receipt">Attach a receipt</label><input id="receipt" type="file">
      <label for="team">Team name</label><input id="team">
    </form>`),
  '/orders/3f2a91b8-c07d-4e65-9a1b-0d3e5f7a9b1c/edit': () => pageHtml('<h1>Order</h1>'),
  '/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c': () => pageHtml('<h1>Reset</h1>'),
  '/report': () => pageHtml('<h1>Report</h1>'),
  '/long': () => pageHtml(`<button id="long">${'n'.repeat(400)}</button><input id="v" aria-label="Value">`),
  '/frame-parent-refused': (host, port) => pageHtml(`<h1>Parent</h1><iframe id="fr" src="http://${host}:${port}/frame-child" width="400" height="200"></iframe>`),
  '/preempt': () => pageHtml('<button id="hidden"><span>Hidden click</span></button>', `<script>
    window.addEventListener('click', function (e) { e.stopImmediatePropagation(); }, true);
  </script>`),
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function serveFixtures(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const render = PAGES[url.pathname];
    if (!render) { res.statusCode = 404; res.end('nope'); return; }
    // The child frame is served on the OTHER host so the iframe is cross-site
    // and Chromium gives it a process of its own.
    const port = (server.address() as net.AddressInfo).port;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(render('localhost', port));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ── Chromium with a remote debugging port, as a vendor would hand it to us ──

interface LaunchedChromium { proc: ChildProcess; endpoint: string; userDataDir: string; exited: Promise<void> }

async function launchChromium(): Promise<LaunchedChromium> {
  const port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-capture-'));
  const proc = spawn(chromium.executablePath(), [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--site-per-process', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: 'ignore' });
  // A process killed by a signal has exitCode null forever; the exit event is
  // the one signal that it is gone.
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${endpoint}/json/version`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('chromium did not open its debugging port');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { proc, endpoint, userDataDir, exited };
}

async function stopChromium(c: LaunchedChromium | null): Promise<void> {
  if (!c) return;
  c.proc.kill('SIGKILL');
  await c.exited;
  fs.rmSync(c.userDataDir, { recursive: true, force: true });
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const session = (endpoint: string) => ({
  id: 'sid', tenantId: 't', agentId: 'a', threadId: 'th', invocationId: null,
  vendor: 'steel', vendorSessionId: endpoint, liveViewUrl: null, createdAt: new Date(),
  lastUsedAt: null, expiresAt: null, closedAt: null, closedReason: null,
  takeoverState: 'taken_over' as const, takenOverAt: new Date(), ownerAccountId: null,
  callerSessionId: null, currentUrl: null, lastScreenshotObjectPath: null, lastScreenshotAt: null,
});

const holdFor = (h: HoldState) => ({
  id: h.id, tenantId: 't', sessionId: 'sid', threadId: 'th',
  startedAt: new Date(), endedAt: null, endReason: null,
  captureOwner: null, captureGeneration: 0, captureLeaseUntil: null, captureGap: false, gapReason: null,
});

let fixtures: Awaited<ReturnType<typeof serveFixtures>>;
let chrome: LaunchedChromium | null = null;
let driver: Browser | null = null;
let holdSeq = 0;

async function startCapture(
  holdId: string,
  endpoint: string,
  timeoutMs = 15_000,
  deps: Record<string, unknown> = {},
): Promise<HoldState> {
  const state = mockStore.newHold(holdId);
  await ensureTakeoverCapture(
    { tenantId: 't', hold: holdFor(state), session: session(endpoint) },
    { timeoutMs, deps: { endpointFor: async () => endpoint, ...deps } as never },
  );
  return state;
}

async function driverPage(): Promise<Page> {
  const context = driver!.contexts()[0];
  return context.newPage();
}

beforeAll(async () => {
  fixtures = await serveFixtures();
});

afterAll(async () => {
  await fixtures.close();
});

beforeEach(async () => {
  mockStore.reset();
  chrome = await launchChromium();
  driver = await chromium.connectOverCDP(chrome.endpoint);
});

afterEach(async () => {
  await _detachAllTakeoverCaptures();
  await driver?.close().catch(() => undefined);
  driver = null;
  await stopChromium(chrome);
  chrome = null;
});

const base = () => `http://127.0.0.1:${fixtures.port}`;
const nextHold = () => `hold-${++holdSeq}`;

describe('what the recorder records', () => {
  it('1. records a genuine click on a captioned button as the button, by name', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/signin`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);
    expect(hold.captureGeneration).toBe(1);

    await page.locator('#signin span').click();
    await until(() => mockStore.actionsFor(hold.id).length >= 1);

    const [click] = mockStore.actionsFor(hold.id);
    expect(click).toMatchObject({ kind: 'click', tag: 'button', role: 'button', name: 'Sign in', url: `${base()}/signin` });
    expect(hold.captureGap).toBe(false);
  });

  it('2. page code that wraps the binding and patches JSON, isTrusted and addEventListener sees nothing and changes nothing', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/hostile`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);
    // Patch again AFTER the recorder attached, as a page reacting to it would.
    await page.evaluate(() => (window as unknown as { __wrapAgain: () => void }).__wrapAgain());

    await page.locator('#signin span').click();
    await until(() => mockStore.actionsFor(hold.id).length >= 1);
    await new Promise((r) => setTimeout(r, 300));

    // The pointer resting on the button after the click is a hover of its
    // own; the click is the one row the page could have tried to fake.
    const clicks = () => mockStore.actionsFor(hold.id).filter((a) => a.kind !== 'hover');
    expect(clicks()).toHaveLength(1);
    expect(clicks()[0]).toMatchObject({ kind: 'click', name: 'Sign in' });
    // The page's wrapper never saw a payload: the binding is not on its window.
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
    expect(seen.filter((s) => s.startsWith('{'))).toEqual([]);
    expect(await page.evaluate((name) => typeof (window as unknown as Record<string, unknown>)[name], TAKEOVER_BINDING)).toBe('undefined');

    // A call to a same-named binding from the page's own world reaches a
    // session that is not ours: the driver installs one in every context and
    // the page calls it, and no row appears.
    const cdp = await driver!.contexts()[0].newCDPSession(page);
    await cdp.send('Runtime.addBinding', { name: TAKEOVER_BINDING });
    const forged = JSON.stringify({
      nonce: 'forged', seq: 0, kind: 'click', url: `${base()}/hostile`, urlTruncated: false, urlProtectedDataOmitted: false,
      tag: 'button', role: 'button', name: 'Forged', nameTruncated: false, inputType: '',
      value: '', valueTruncated: false, valueDisposition: 'none', detail: '', detailTruncated: false, at: 1,
    });
    await cdp.send('Runtime.evaluate', { expression: `window[${JSON.stringify(TAKEOVER_BINDING)}](${JSON.stringify(forged)})` });
    await new Promise((r) => setTimeout(r, 300));
    expect(clicks()).toHaveLength(1);
    await cdp.detach();
  });

  it('3. a script-dispatched click records nothing', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/signin`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.evaluate(() => {
      document.querySelector('#signin')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(mockStore.actionsFor(hold.id)).toHaveLength(0);
  });

  it('4. a navigation keeps its resource id, query filter and SPA fragment, and a reset token or signed parameter is replaced with its flag', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/signin`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.goto(`${base()}/orders/3f2a91b8c07d4e65/edit?tab=1#x`);
    await page.goto(`${base()}/orders/3f2a91b8-c07d-4e65-9a1b-0d3e5f7a9b1c/edit?filter=open&sort=updated#/history?page=2`);
    await page.goto(`${base()}/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=abc123`);
    await page.goto(`${base()}/report?sig=deadbeef&q=quarterly`);
    await until(() => mockStore.actionsFor(hold.id).filter((a) => a.kind === 'navigate').length >= 4);

    const navs = mockStore.actionsFor(hold.id).filter((a) => a.kind === 'navigate');
    expect(navs.map((a) => a.url)).toEqual([
      `${base()}/orders/3f2a91b8c07d4e65/edit?tab=1#x`,
      `${base()}/orders/3f2a91b8-c07d-4e65-9a1b-0d3e5f7a9b1c/edit?filter=open&sort=updated#/history?page=2`,
      `${base()}/reset-password/[redacted]?token=[redacted]`,
      `${base()}/report?sig=[redacted]&q=quarterly`,
    ]);
    expect(navs.map((a) => a.urlProtectedDataOmitted)).toEqual([false, false, true, true]);
    expect(JSON.stringify(navs)).not.toMatch(/abc123|deadbeef|3f2a91b8c07d4e659a1b0d3e5f7a9b1c/);
  });

  it('5. typing a secret into a password field and pressing Enter records the field, not the value', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/signin`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#pw').click();
    await page.keyboard.type('hunter2-secret');
    await page.keyboard.press('Enter');
    await until(() => mockStore.actionsFor(hold.id).some((a) => a.kind === 'enter'));

    const enter = mockStore.actionsFor(hold.id).find((a) => a.kind === 'enter')!;
    expect(enter).toMatchObject({ kind: 'enter', tag: 'input', inputType: 'password', name: 'Password', value: null, valueDisposition: 'authentication_omitted' });
    expect(JSON.stringify(mockStore.actionsFor(hold.id))).not.toContain('hunter2-secret');
  });

  it('6. page-authored labels and captions ARE captured as names, and can echo entered content (the documented limit)', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/signin`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#cont').click();
    await page.locator('#code').click();
    await until(() => mockStore.actionsFor(hold.id).length >= 2);

    const names = mockStore.actionsFor(hold.id).map((a) => a.name);
    expect(names).toContain('Continue as jane@example.com');
    expect(names).toContain('Enter the code XYZ-SECRET-CODE here');
  });
});

describe('the lease', () => {
  it('7. an attach against a closed port releases the claim as never_attached and marks the hold', async () => {
    const closed = await freePort();
    const hold = await startCapture(nextHold(), `http://127.0.0.1:${closed}`, 10_000);
    expect(hold.captureOwner).toBeNull();
    expect(hold.captureGap).toBe(true);
    expect(hold.gapReason).toBe('never_attached');
    expect(_activeTakeoverCaptures().has(hold.id)).toBe(false);
  });

  it('8. a browser killed mid-hold releases the lease as lost_owner, and the next claim is generation 2', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/signin`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);
    expect(hold.captureOwner).toBe(CAPTURE_OWNER);

    chrome!.proc.kill('SIGKILL');
    await until(() => hold.captureOwner === null, 15_000);
    expect(hold.captureGap).toBe(true);
    expect(hold.gapReason).toBe('lost_owner');
    await driver!.close().catch(() => undefined);
    driver = null;
    await stopChromium(chrome);

    chrome = await launchChromium();
    driver = await chromium.connectOverCDP(chrome.endpoint);
    const again = await driverPage();
    await again.goto(`${base()}/signin`);
    await ensureTakeoverCapture(
      { tenantId: 't', hold: holdFor(hold), session: session(chrome.endpoint) },
      { timeoutMs: 15_000, deps: { endpointFor: async () => chrome!.endpoint } },
    );
    expect(hold.captureGeneration).toBe(2);
    expect(hold.captureOwner).toBe(CAPTURE_OWNER);
    await again.locator('#signin span').click();
    await until(() => mockStore.actionsFor(hold.id).length >= 1);
    expect(mockStore.actionsFor(hold.id)[0].generation).toBe(2);
  });
});

describe('a close is not a lost owner', () => {
  it('12. a hold ended by a session close, then the browser stopped: the disconnect records no gap', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/signin`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);
    await page.locator('#signin span').click();
    await until(() => mockStore.actionsFor(hold.id).length >= 1);

    // The close's opening act (endTakeoverHoldForClose): the hold ends
    // BEFORE the vendor is told to stop the browser.
    hold.endedAt = new Date();
    chrome!.proc.kill('SIGKILL');
    await chrome!.exited;
    await until(() => !_activeTakeoverCaptures().has(hold.id), 15_000);

    expect(hold.captureGap).toBe(false);
    expect(hold.gapReason).toBeNull();
    expect(mockStore.actionsFor(hold.id)).toHaveLength(1);
    await driver!.close().catch(() => undefined);
    driver = null;
  });
});

describe('frames and bounds', () => {
  it("9. a click inside a cross-site iframe is recorded through the frame's own session", async () => {
    const page = await driverPage();
    await page.goto(`${base()}/frame-parent`);
    await page.frameLocator('#fr').locator('#child').waitFor();
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.frameLocator('#fr').locator('#child span').click();
    await until(() => mockStore.actionsFor(hold.id).some((a) => a.kind === 'click'));

    const click = mockStore.actionsFor(hold.id).find((a) => a.kind === 'click')!;
    expect(click).toMatchObject({ tag: 'button', name: 'Child button', url: `http://localhost:${fixtures.port}/frame-child` });
  });

  it('10. 501 trusted clicks across two pages at once, with concurrent binding deliveries, yield exactly 500 rows and a cap gap', async () => {
    // Two pages, two targets, two CDP sessions: their binding calls arrive
    // interleaved, and the repository's lock-then-count is what keeps the
    // 501st out whichever target it came from.
    const first = await driverPage();
    const second = await driverPage();
    await first.goto(`${base()}/many`);
    await second.goto(`${base()}/many`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    const clickTimes = async (page: Page, n: number) => {
      const box = (await page.locator('#many').boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      for (let i = 0; i < n; i++) await page.mouse.click(x, y, { delay: 0 });
    };
    await Promise.all([clickTimes(first, 251), clickTimes(second, 250)]);
    await until(() => hold.gapReason === 'cap', 60_000);
    await new Promise((r) => setTimeout(r, 500));

    expect(mockStore.actionsFor(hold.id)).toHaveLength(500);
    const nonces = new Set(mockStore.actionsFor(hold.id).map((a) => a.nonce));
    expect(nonces.size).toBe(2);
    expect(hold.captureGap).toBe(true);
    expect(hold.gapReason).toBe('cap');
  });

  it('11. a capture listener the page registered before the recorder attached can hide a click; capture_gap does not claim otherwise', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/preempt`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#hidden span').click();
    await new Promise((r) => setTimeout(r, 500));

    // The documented limit: the page's earlier capture listener stopped the
    // event before the recorder's, and nothing on the hold says so.
    expect(mockStore.actionsFor(hold.id).filter((a) => a.kind === 'click')).toHaveLength(0);
    expect(hold.captureGap).toBe(false);

    // On a NEW document the recorder is first, so the same page cannot hide it.
    await page.reload();
    await page.locator('#hidden span').click();
    await until(() => mockStore.actionsFor(hold.id).some((a) => a.kind === 'click'));
    expect(mockStore.actionsFor(hold.id).find((a) => a.kind === 'click')).toMatchObject({ name: 'Hidden click' });
  });
});

// ── What was entered, and the interactions the five-kind recorder missed ────

const rowsOf = (holdId: string, kind?: string) =>
  mockStore.actionsFor(holdId).filter((a) => a.kind !== 'hover' && (!kind || a.kind === kind));

describe('values and the new kinds', () => {
  it('13. records a value on change, the value at the moment of Enter, and a contenteditable blur, deduping the change that repeats the Enter', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/issues`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#q').click();
    await page.keyboard.type('browser');
    await page.keyboard.press('Enter');
    // The page navigates on submit; the change event fires on blur/submit and
    // repeats the Enter value on the same control, so it is not a second row.
    await until(() => rowsOf(hold.id, 'enter').length >= 1);
    await page.locator('#notes').click();
    await page.keyboard.type('follow up on Tuesday');
    await page.locator('#q').click();
    await until(() => rowsOf(hold.id, 'change').some((a) => a.name === 'Notes'));
    await new Promise((r) => setTimeout(r, 300));

    const enter = rowsOf(hold.id, 'enter')[0];
    expect(enter).toMatchObject({ tag: 'input', role: 'textbox', name: 'Search all issues', value: 'browser', valueDisposition: 'recorded', inputType: 'text' });
    const changes = rowsOf(hold.id, 'change');
    expect(changes.filter((a) => a.name === 'Search all issues' && a.value === 'browser')).toHaveLength(0);
    expect(changes.find((a) => a.name === 'Notes')).toMatchObject({ tag: 'div', value: 'follow up on Tuesday', valueDisposition: 'recorded' });
    // A submit is recorded, and the SPA navigation the page made keeps its query and fragment.
    expect(rowsOf(hold.id, 'submit')).toHaveLength(1);
    expect(rowsOf(hold.id, 'navigate').map((a) => a.url)).toContain(`${base()}/issues?q=browser#results`);
  });

  it('14. a multi-select records every chosen option\'s text, a checkbox its state', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/issues`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    // Real input only: Playwright's selectOption and check dispatch their
    // change events from script, which the recorder rightly drops as
    // untrusted, so the options are clicked and the box is clicked.
    await page.locator('#status option', { hasText: 'Open' }).click();
    await page.locator('#status option', { hasText: 'Draft' }).click({ modifiers: ['Shift'] });
    await page.locator('#archived').click();
    await until(() => rowsOf(hold.id, 'change').filter((a) => a.tag === 'input').length >= 1);
    await until(() => rowsOf(hold.id, 'change').filter((a) => a.tag === 'select').length >= 1);

    const selects = rowsOf(hold.id, 'change').filter((a) => a.tag === 'select');
    expect(selects[selects.length - 1]).toMatchObject({ tag: 'select', role: 'listbox', name: 'Status', value: 'Open, Closed, Draft', valueDisposition: 'recorded' });
    const box = rowsOf(hold.id, 'change').find((a) => a.tag === 'input')!;
    expect(box).toMatchObject({ tag: 'input', inputType: 'checkbox', name: 'Include archived', value: 'checked', valueDisposition: 'recorded' });
  });

  it('15. an allow-listed key chord is a key action, a printable keystroke is not recorded, Enter outside an editable control is a key', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/issues`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#q').click();
    await page.keyboard.type('abc');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Escape');
    await page.locator('#commits').focus();
    await page.keyboard.press('Enter');
    await until(() => rowsOf(hold.id, 'key').length >= 3);
    await new Promise((r) => setTimeout(r, 300));

    expect(rowsOf(hold.id, 'key').map((a) => a.detail)).toEqual(['Shift+Tab', 'Escape', 'Enter']);
    expect(rowsOf(hold.id, 'key')[2]).toMatchObject({ tag: 'a', role: 'link', name: 'Commits' });
    // The three printable keystrokes were never their own rows.
    expect(rowsOf(hold.id).filter((a) => a.detail === 'a' || a.detail === 'b' || a.detail === 'c')).toHaveLength(0);
  });

  it('16. a scroll is debounced into a direction and a final position, a drag carries its source, a context menu and a canvas click carry coordinates', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/issues`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.mouse.move(100, 100);
    await page.mouse.wheel(0, 600);
    await page.mouse.wheel(0, 600);
    await until(() => rowsOf(hold.id, 'scroll').length >= 1);
    expect(rowsOf(hold.id, 'scroll')).toHaveLength(1);
    expect(rowsOf(hold.id, 'scroll')[0].detail).toMatch(/^scroll down to 0%,\d+%$/);
    expect(Number(rowsOf(hold.id, 'scroll')[0].detail!.match(/,(\d+)%$/)![1])).toBeGreaterThan(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    await until(() => rowsOf(hold.id, 'scroll').length >= 2);
    await page.locator('#card').dragTo(page.locator('#done'));
    await until(() => rowsOf(hold.id, 'drag').length >= 1);
    expect(rowsOf(hold.id, 'drag')[0]).toMatchObject({ role: 'listitem', name: 'Done', detail: 'from li listitem "Card 4"' });

    await page.locator('#commits').click({ button: 'right' });
    await until(() => rowsOf(hold.id, 'contextmenu').length >= 1);
    expect(rowsOf(hold.id, 'contextmenu')[0]).toMatchObject({ tag: 'a', role: 'link', name: 'Commits' });
    await page.keyboard.press('Escape');

    const box = (await page.locator('#chart').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
    await until(() => rowsOf(hold.id, 'click').some((a) => a.tag === 'canvas'));
    expect(rowsOf(hold.id, 'click').find((a) => a.tag === 'canvas')!.detail).toBe('at 25%,50%');
  });

  it('17. a pointer resting on an interactive control is a hover, consecutive repeats collapsed; a double click is two clicks with their counts', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/issues`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#commits').hover();
    await new Promise((r) => setTimeout(r, 700));
    await page.mouse.move(5, 5);
    await page.locator('#commits').hover();
    await new Promise((r) => setTimeout(r, 700));
    expect(mockStore.actionsFor(hold.id).filter((a) => a.kind === 'hover')).toHaveLength(1);
    expect(mockStore.actionsFor(hold.id).find((a) => a.kind === 'hover')).toMatchObject({ role: 'link', name: 'Commits' });

    await page.locator('#go').dblclick();
    await until(() => rowsOf(hold.id, 'click').length >= 2);
    expect(rowsOf(hold.id, 'click').map((a) => a.detail)).toEqual([null, 'click 2']);
  });

  it('18. a name over 200 characters and a value over 2,000 are cut with their flags', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/long`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#long').click();
    await page.locator('#v').fill('v'.repeat(2500));
    await page.locator('#long').click();
    await until(() => rowsOf(hold.id, 'change').length >= 1);

    const click = rowsOf(hold.id, 'click')[0];
    expect(click.name).toHaveLength(200);
    expect(click.nameTruncated).toBe(true);
    const change = rowsOf(hold.id, 'change')[0];
    expect(change.value).toHaveLength(2000);
    expect(change.valueTruncated).toBe(true);
    expect(change.valueDisposition).toBe('recorded');
  });
});

describe('protected classes', () => {
  it('19. a sign-in form protects every editable control in it: the email and the checkbox go with the password', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/login`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#email').fill('jane@acme.example');
    await page.locator('#pw').fill('hunter2-secret');
    await page.locator('#remember').check();
    await page.locator('#pw').press('Enter');
    await until(() => rowsOf(hold.id, 'enter').length >= 1);
    await new Promise((r) => setTimeout(r, 300));

    for (const a of [...rowsOf(hold.id, 'change'), ...rowsOf(hold.id, 'enter')]) {
      expect(a.valueDisposition).toBe('authentication_omitted');
      expect(a.value).toBeNull();
    }
    expect(rowsOf(hold.id, 'change').map((a) => a.name)).toEqual(expect.arrayContaining(['Email address', 'Password', 'Remember me']));
    expect(rowsOf(hold.id, 'enter')[0]).toMatchObject({ inputType: 'password', name: 'Password' });
    expect(JSON.stringify(mockStore.actionsFor(hold.id))).not.toMatch(/jane@acme|hunter2/);
  });

  it('20. a checkout protects the card fields only: the billing address and a promo code survive exactly', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/checkout`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#cardname').fill('Jane Doe');
    await page.locator('#cardnum').fill('4111 1111 1111 1111');
    await page.locator('#cvv').fill('123');
    await page.locator('#street').fill('221B Baker Street');
    await page.locator('#city').fill('London');
    await page.locator('#promo').fill('SPRING25');
    await page.locator('#cardname').click();
    await until(() => rowsOf(hold.id, 'change').length >= 6);

    const byName = Object.fromEntries(rowsOf(hold.id, 'change').map((a) => [a.name, a]));
    expect(byName['Name on card']).toMatchObject({ value: null, valueDisposition: 'payment_omitted' });
    expect(byName['Card number']).toMatchObject({ value: null, valueDisposition: 'payment_omitted' });
    expect(byName['CVV']).toMatchObject({ value: null, valueDisposition: 'payment_omitted' });
    expect(byName['Street address']).toMatchObject({ value: '221B Baker Street', valueDisposition: 'recorded' });
    expect(byName['City']).toMatchObject({ value: 'London', valueDisposition: 'recorded' });
    expect(byName['Promo code']).toMatchObject({ value: 'SPRING25', valueDisposition: 'recorded' });
    expect(JSON.stringify(mockStore.actionsFor(hold.id))).not.toMatch(/4111|Jane Doe/);
  });

  it('21. a government id, a date of birth and a file input are omitted with their class; an ordinary field beside them is recorded', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/onboarding`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#ssn').fill('123-45-6789');
    await page.locator('#dob').fill('02/01/1990');
    // The file is set the way the browser's own chooser sets it, over CDP
    // (DOM.setFileInputFiles), so the change event is the browser's own; a
    // buffer payload through Playwright would be a script-made one.
    const receipt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-file-')), 'receipt-synthetic.pdf');
    fs.writeFileSync(receipt, '%PDF-');
    const fileCdp = await driver!.contexts()[0].newCDPSession(page);
    const { root } = await fileCdp.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await fileCdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#receipt' });
    await fileCdp.send('DOM.setFileInputFiles', { nodeId, files: [receipt] });
    await fileCdp.detach();
    await page.locator('#team').fill('Platform');
    await page.locator('#ssn').click();
    await until(() => rowsOf(hold.id, 'change').length >= 4, 15_000);

    const byName = Object.fromEntries(rowsOf(hold.id, 'change').map((a) => [a.name, a]));
    expect(byName['Social security number']).toMatchObject({ value: null, valueDisposition: 'sensitive_identity_omitted' });
    expect(byName['Date of birth']).toMatchObject({ value: null, valueDisposition: 'sensitive_identity_omitted' });
    expect(byName['Attach a receipt']).toMatchObject({ value: null, valueDisposition: 'file_omitted', inputType: 'file' });
    expect(byName['Team name']).toMatchObject({ value: 'Platform', valueDisposition: 'recorded' });
    expect(JSON.stringify(mockStore.actionsFor(hold.id))).not.toMatch(/123-45|1990|receipt-synthetic/);
  });

  it('22. the stated limit: a credential typed into an unlabelled ordinary field is dropped only when the text itself is credential-shaped', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/issues`);
    const hold = await startCapture(nextHold(), chrome!.endpoint);

    await page.locator('#q').fill('ghp_' + 'a'.repeat(36));
    await page.locator('#notes').click();
    await until(() => rowsOf(hold.id, 'change').length >= 1);

    // The page declared nothing; the Node-side redactor is the second layer.
    expect(rowsOf(hold.id, 'change')[0]).toMatchObject({ value: null, valueDisposition: 'sensitive_text_omitted' });
    expect(JSON.stringify(mockStore.actionsFor(hold.id))).not.toContain('ghp_');
  });
});

// ── A known partial attachment marks the hold ───────────────────────────────

describe('partial attachment', () => {
  it('23. a second page whose CDP session is refused marks the hold frame_unavailable while the first page keeps recording', async () => {
    const first = await driverPage();
    await first.goto(`${base()}/signin`);
    const second = await driverPage();
    await second.goto(`${base()}/many`);
    const refuse = second.url();
    const hold = await startCapture(nextHold(), chrome!.endpoint, 15_000, {
      connect: async (endpoint: string) => {
        const browser = await chromium.connectOverCDP(endpoint);
        const context = browser.contexts()[0];
        const real = context.newCDPSession.bind(context);
        context.newCDPSession = (async (target: Page | { url?: () => string }) => {
          if ('url' in target && typeof target.url === 'function' && target.url() === refuse) throw new Error('Target closed');
          return real(target as Page);
        }) as typeof context.newCDPSession;
        return browser;
      },
    });
    await until(() => hold.gapReason === 'frame_unavailable');
    expect(hold.captureGap).toBe(true);
    expect(hold.captureOwner).toBe(CAPTURE_OWNER);
    expect(_activeTakeoverCaptures().get(hold.id)?.attached).toBe(true);

    await first.locator('#signin span').click();
    await until(() => rowsOf(hold.id, 'click').length >= 1);
    expect(rowsOf(hold.id, 'click')[0]).toMatchObject({ name: 'Sign in' });
  });

  it('24. an out-of-process iframe whose install fails marks the hold frame_unavailable', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/frame-parent-refused`);
    await page.frameLocator('#fr').locator('#child').waitFor();
    const hold = await startCapture(nextHold(), chrome!.endpoint, 15_000, {
      connect: async (endpoint: string) => {
        const browser = await chromium.connectOverCDP(endpoint);
        const context = browser.contexts()[0];
        const real = context.newCDPSession.bind(context);
        context.newCDPSession = (async (target: Page | { url?: () => string; parentFrame?: () => unknown }) => {
          const session = await real(target as Page);
          // A frame target: its install fails on the first CDP command.
          if ('parentFrame' in target && typeof target.parentFrame === 'function' && target.parentFrame()) {
            const send = session.send.bind(session);
            session.send = (async (method: string, params?: unknown) => {
              if (method === 'Page.enable') throw new Error('Session refused');
              return send(method as never, params as never);
            }) as typeof session.send;
          }
          return session;
        }) as typeof context.newCDPSession;
        return browser;
      },
    });
    await until(() => hold.gapReason === 'frame_unavailable');
    expect(_activeTakeoverCaptures().get(hold.id)?.attached).toBe(true);
    await page.locator('h1').click();
    await until(() => rowsOf(hold.id, 'click').length >= 1);
  });
});

// ── The call-scoped task capture ────────────────────────────────────────────

const holdRowsToActions = (rows: ObservedAction[]) => rows.map(({ row }) => row);

describe('task capture', () => {
  it('25. an Anchor-shaped task (no native steps) is supplied by the observation: navigate, click, ordinary entry, whole-auth-form omission, in order, from trusted CDP-generated input', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/issues`);
    const capture = await TaskCapture.attach(session(chrome!.endpoint) as never, 't', { timeoutMs: 15_000, deps: { endpointFor: async () => chrome!.endpoint } });
    expect(capture.attached).toBe(true);

    // The "agent": Playwright over CDP, exactly as Stagehand drives a page.
    await page.locator('#q').fill('browser');
    await page.locator('#go').click();
    await page.goto(`${base()}/login`);
    await page.locator('#email').fill('jane@acme.example');
    await page.locator('#pw').fill('hunter2-secret');
    await page.locator('#submit').click();
    await new Promise((r) => setTimeout(r, 400));

    const observed = await capture.finish();
    expect(observed.captureGap).toBe(false);
    const trail = reconcileTrail(null, observedStepsFrom(observed.actions), observed);
    const actions = trail.steps.map((s) => s.action);
    expect(actions).toEqual(expect.arrayContaining([
      'entered "browser" in textbox "Search all issues"',
      'clicked button "Search"',
      `opened ${base()}/login`,
      'entered authentication data (not recorded) in textbox "Email address"',
      'entered authentication data (not recorded) in textbox "Password"',
      'clicked button "Sign in"',
    ]));
    // Order is the page's order.
    expect(actions.indexOf('entered "browser" in textbox "Search all issues"')).toBeLessThan(actions.indexOf('clicked button "Search"'));
    expect(actions.indexOf(`opened ${base()}/login`)).toBeLessThan(actions.indexOf('clicked button "Sign in"'));
    expect(JSON.stringify(trail)).not.toMatch(/jane@acme|hunter2/);
    expect(trail.steps.every((s) => s.at instanceof Date)).toBe(true);
  });

  it('26. a Stagehand-shaped task: observed steps collapse its act, fillForm and goto, retain its extract and wait, and no act is duplicated', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/issues`);
    const capture = await TaskCapture.attach(session(chrome!.endpoint) as never, 't', { timeoutMs: 15_000, deps: { endpointFor: async () => chrome!.endpoint } });

    await page.locator('#q').fill('browser');
    await page.locator('#go').click();
    await page.goto(`${base()}/report`);
    await new Promise((r) => setTimeout(r, 400));
    const observed = await capture.finish();

    const native = projectStagehandSteps([
      { type: 'act', pageUrl: `${base()}/issues`, playwrightArguments: { method: 'fill', description: 'the Search all issues box', arguments: ['browser'] } },
      { type: 'act', pageUrl: `${base()}/issues`, playwrightArguments: { method: 'click', description: 'the Search button', arguments: [] } },
      { type: 'extract', pageUrl: `${base()}/issues?q=browser#results`, instruction: 'read the count' },
      { type: 'goto', url: `${base()}/report` },
      { type: 'wait', timeMs: 500 },
      { type: 'close' },
    ]).steps;
    const trail = reconcileTrail(native, observedStepsFrom(observed.actions), observed);
    const types = trail.steps.map((s) => s.type);
    expect(types.filter((t) => t === 'act')).toHaveLength(0);
    expect(types).toEqual(expect.arrayContaining(['change', 'click', 'extract', 'navigate', 'wait', 'close']));
    expect(types.indexOf('change')).toBeLessThan(types.indexOf('click'));
    expect(types.indexOf('click')).toBeLessThan(types.indexOf('extract'));
    expect(types.indexOf('extract')).toBeLessThan(types.lastIndexOf('navigate'));
    expect(types.indexOf('wait')).toBeLessThan(types.indexOf('close'));
    expect(trail.captureGap).toBe(false);
  });

  it('27. a forced attach failure is a gap the trail carries, never a silently complete trail', async () => {
    const closed = await freePort();
    const capture = await TaskCapture.attach(session(`http://127.0.0.1:${closed}`) as never, 't', { timeoutMs: 5_000, deps: { endpointFor: async () => `http://127.0.0.1:${closed}` } });
    expect(capture.attached).toBe(false);
    const observed = await capture.finish();
    expect(observed).toMatchObject({ captureGap: true, gapReason: 'attach_failed', actions: [] });
    const trail = reconcileTrail(null, [], observed);
    expect(trail).toMatchObject({ captureGap: true, gapReason: 'attach_failed', steps: [] });
  });

  it('28. observed actions inside a takeover hold that overlaps the task are the person\'s, and an open hold is bounded by the task\'s finish', async () => {
    const page = await driverPage();
    await page.goto(`${base()}/issues`);
    const capture = await TaskCapture.attach(session(chrome!.endpoint) as never, 't', { timeoutMs: 15_000, deps: { endpointFor: async () => chrome!.endpoint } });

    await page.locator('#go').click();
    await new Promise((r) => setTimeout(r, 300));
    const holdStart = new Date();
    await new Promise((r) => setTimeout(r, 50));
    await page.locator('#commits').click();
    await new Promise((r) => setTimeout(r, 300));
    const observed = await capture.finish();

    const before = holdRowsToActions(observed.actions).filter((r) => r.kind === 'click').map((r) => r.name);
    expect(before).toEqual(['Search', 'Commits']);
    const own = withoutTakeoverIntervals(observed.actions, [{ startedAt: holdStart, endedAt: null }], observed.endedAt);
    expect(holdRowsToActions(own).filter((r) => r.kind === 'click').map((r) => r.name)).toEqual(['Search']);
  });
});
