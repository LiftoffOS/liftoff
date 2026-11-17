// The saved-login fill against a real Chromium, driven over CDP exactly as
// the runtime drives a vendor's session: the pooled connection, the
// recorder warmed for the session's lifetime, the sign-in controls found by
// the pane's own walk and classifier, the value typed through the pane's
// own path, and the outcome observed rather than assumed.
//
// jsdom cannot show any of this: whether a username-first page on a sign-in
// route is recognised with no password box on it; whether a submit lands
// and the next document is walked; whether a TOTP step is filled from a
// fresh read; whether a form inside a same-origin frame is found and filled;
// whether a page with a search box and no sign-in form is left alone; and
// whether a second visit to an origin already signed in refills. The
// resolver is stubbed: the vault is a fixture, never the SDK. Runs under
// jest.browser.config.js.

import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium } from 'playwright-core';

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The endpoint every connect resolves to: the launched Chromium.
let endpoint = '';
jest.mock('../../../browser-sessions/session-vendor-proxy', () => ({
  cdpEndpointFor: async () => endpoint,
}));

// ── The in-memory repository ────────────────────────────────────────────────

interface SessionState { id: string; tenantId: string; threadId: string | null; invocationId: string | null; vendor: string; vendorSessionId: string; takeoverState: 'none' | 'taken_over'; takenOverAt: Date | null; callerSessionId: string; agentId: string; closedAt: null; pageSnapshot: unknown; currentUrl: string | null; currentTitle: string | null; viewport: { width: number; height: number } | null }
const store = {
  session: null as SessionState | null,
  activity: [] as Array<Record<string, unknown>>,
  interventions: [] as Array<Record<string, unknown>>,
  reset() { this.session = null; this.activity = []; this.interventions = []; },
};
const sessionOf = () => ({
  ...store.session!, liveViewUrl: null, createdAt: new Date(), lastUsedAt: null, expiresAt: null, closedReason: null,
  ownerAccountId: null, lastScreenshotObjectPath: null, lastScreenshotAt: null,
});
jest.mock('../../../browser-sessions/repository', () => ({
  getById: async (id: string) => (store.session && store.session.id === id ? sessionOf() : null),
  getByVendorSessionId: async () => (store.session ? sessionOf() : null),
  setPageSnapshot: async (_id: string, snapshot: unknown) => { store.session!.pageSnapshot = snapshot; return sessionOf(); },
  setCurrentUrl: async (_v: string, url: string, title: string | null) => { store.session!.currentUrl = url; store.session!.currentTitle = title; return sessionOf(); },
}));
jest.mock('../../../browser-sessions/events', () => ({ emitBrowserSessionEvent: jest.fn() }));
jest.mock('../../../browser-sessions/activity-repository', () => ({
  ...jest.requireActual('../../../browser-sessions/activity-repository'),
  recordBrowserActivity: async (input: Record<string, unknown>) => { store.activity.push(input); return input.id as string; },
}));
jest.mock('../../../browser-sessions/interventions', () => ({
  requestIntervention: async (input: Record<string, unknown>) => {
    store.interventions.push(input);
    return { intervention: { requestedAt: new Date() }, alreadyPending: false };
  },
}));
jest.mock('../../../browser-sessions/takeover-capture/repository', () => ({
  claimCapture: async () => 1,
  renewCapture: async () => true,
  releaseCapture: async () => undefined,
  markCaptureGap: async () => undefined,
  insertAction: async () => 'inserted',
  insertPointHold: async () => 'point-1',
}));

// The resolver, stubbed: a fixture vault.
const PASSWORD = 'correct-horse-battery';
const USERNAME = 'jane.doe@a.test';
const vault = {
  available: true,
  match: null as null | 'ambiguous' | { vaultId: string; itemId: string; title: string; websites: unknown[]; username: null },
  totp: null as null | { code: string } | { error: string },
  unusable: false,
  /** An item that holds a password and an EMPTY username field: the real
   *  resolver reads that as no pair at all (logins.ts `valueOf`). */
  passwordOnly: false,
  resolveCalls: 0,
};
jest.mock('../logins', () => ({
  isLoginSourceAvailable: async () => vault.available,
  findLoginForUrl: async () => vault.match,
  resolveLogin: async () => {
    vault.resolveCalls += 1;
    if (!vault.match || vault.match === 'ambiguous') return null;
    if (vault.unusable) return 'unusable';
    if (vault.passwordOnly) return 'unusable';
    return {
      username: USERNAME,
      password: PASSWORD,
      ...(vault.totp && 'code' in vault.totp ? { totpCode: `${vault.totp.code}${vault.resolveCalls}` } : {}),
      ...(vault.totp && 'error' in vault.totp ? { totpError: vault.totp.error } : {}),
    };
  },
}));

import { applySavedLogin, applySavedLoginAfterNavigation, applySavedLoginOnPane, _resetSavedLoginAttemptsForTesting, _attemptedOriginsForTesting } from '../autofill';
import { holdPaneAction } from '../../../browser-sessions/pane-actions';
import { _endAllSessionCaptures } from '../../../browser-sessions/takeover-capture/session-capture';
import { _closeCdpPool } from '../../../browser-sessions/cdp-page';
import type { BrowserTaskStep } from '../../web-fetch/step-policy';

// ── Fixture pages ───────────────────────────────────────────────────────────

function pageHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title></head><body style="margin:0">${body}</body></html>`;
}

const field = (id: string, label: string, type: string, extra = '') =>
  `<label for="${id}">${label}</label><input id="${id}" name="${id}" type="${type}" ${extra} style="display:block;width:220px;height:30px;margin:8px 0">`;

/** Every POST the fixtures receive, so the test can assert what was typed
 *  without reading it back from the page. */
const posts: Array<{ path: string; body: Record<string, string> }> = [];

const PAGES: Record<string, (port: number) => string> = {
  // A single-step sign-in on an ordinary route: the password box protects
  // the form, so the username box is authentication-class too.
  '/account': () => pageHtml(`
    <h1>Account</h1>
    <form method="post" action="/account">
      ${field('user', 'Email', 'email')}
      ${field('pw', 'Password', 'password')}
      <button type="submit">Sign in</button>
    </form>`),
  // Username-first, on a sign-in route: no password box; every editable
  // control on the route is authentication-class.
  '/signin': () => pageHtml(`
    <h1>Sign in</h1>
    <form method="post" action="/signin">
      ${field('user', 'Email address', 'text')}
      <button type="submit">Next</button>
    </form>`),
  '/signin/password': () => pageHtml(`
    <h1>Enter your password</h1>
    <form method="post" action="/signin/password">
      ${field('pw', 'Password', 'password')}
      <button type="submit">Sign in</button>
    </form>`),
  // A sign-in whose second step asks for a one-time code.
  '/mfa': () => pageHtml(`
    <h1>Account</h1>
    <form method="post" action="/mfa">
      ${field('user', 'Email', 'email')}
      ${field('pw', 'Password', 'password')}
      <button type="submit">Sign in</button>
    </form>`),
  '/mfa/otp': () => pageHtml(`
    <h1>Verify</h1>
    <form method="post" action="/mfa/otp">
      ${field('code', 'One-time code', 'text', 'autocomplete="one-time-code" inputmode="numeric"')}
      <button type="submit">Verify</button>
    </form>`),
  // The code step as the WebAuthn conditional-UI pattern writes it: the token
  // list `one-time-code webauthn`, not the bare token.
  '/mfa/otp-webauthn': () => pageHtml(`
    <h1>Verify</h1>
    <form method="post" action="/mfa/otp">
      ${field('code', 'Enter the code we sent', 'text', 'autocomplete="one-time-code webauthn" inputmode="numeric"')}
      <button type="submit">Verify</button>
    </form>`),
  // A sign-in page with the site's own search box in the header, BEFORE the
  // form. Every editable control here is authentication-class: the route is a
  // sign-in route.
  '/signin/portal': (port) => pageHtml(`
    <form method="get" action="/results" style="margin-bottom:12px">
      ${field('q', 'Search the help centre', 'search')}
    </form>
    <h1>Sign in</h1>
    <form method="post" action="/signin/portal">
      ${field('user', 'Email', 'email')}
      ${field('pw', 'Password', 'password')}
      <button type="submit">Sign in</button>
    </form>
    <p>${port}</p>`),
  // Signed in.
  '/home': () => pageHtml('<h1>Welcome</h1><a href="/account">Account</a><input aria-label="Search" style="width:200px;height:30px">'),
  // A page with a search box and no sign-in form.
  '/search': () => pageHtml('<h1>Search</h1><form method="get" action="/results"><input id="q" name="q" aria-label="Search" style="width:220px;height:30px"><button>Go</button></form>'),
  // A sign-in form inside a same-origin frame.
  '/framed': (port) => pageHtml(`<h1>Portal</h1><iframe id="f" src="http://127.0.0.1:${port}/account" style="position:absolute;left:20px;top:60px;width:400px;height:300px;border:0"></iframe>`),
  // A page whose submit lands on a sign-in route with no form: "check your
  // email", still on the way in.
  '/link': () => pageHtml(`
    <h1>Sign in</h1>
    <form method="post" action="/link">
      ${field('user', 'Email', 'email')}
      ${field('pw', 'Password', 'password')}
      <button type="submit">Sign in</button>
    </form>`),
  '/signin/sent': () => pageHtml('<h1>Check your email</h1><p>We sent you a link.</p>'),
  // A sign-in page built out of components rather than a form: the boxes
  // belong to NO form element, and the button sends them from script. HTML
  // gives an input with no form owner no implicit submission, so Enter does
  // nothing here and the button has to be clicked.
  '/signin/spa': () => pageHtml(`
    <h1>Sign in</h1>
    ${field('user', 'Email', 'email')}
    ${field('pw', 'Password', 'password')}
    <button id="go" style="height:30px">Sign in</button>
    <script>
      document.getElementById('go').addEventListener('click', function () {
        var f = document.createElement('form');
        f.method = 'post'; f.action = '/signin/spa';
        [['user', document.getElementById('user').value], ['pw', document.getElementById('pw').value]]
          .forEach(function (p) {
            var i = document.createElement('input');
            i.type = 'hidden'; i.name = p[0]; i.value = p[1];
            f.appendChild(i);
          });
        document.body.appendChild(f);
        f.submit();
      });
    </script>`),
  // A page that pulls focus away the first time the username box takes it,
  // the way a page settling after load does. The first click focuses the
  // box and loses it; a second, freshly measured click holds.
  '/signin/steals': () => pageHtml(`
    <h1>Sign in</h1>
    <form method="post" action="/signin/steals">
      ${field('user', 'Email', 'email')}
      ${field('pw', 'Password', 'password')}
      <button type="submit">Sign in</button>
    </form>
    <a id="elsewhere" href="#" style="display:block;width:120px">Need help?</a>
    <script>
      var stolen = false;
      document.getElementById('user').addEventListener('focus', function () {
        if (stolen) return;
        stolen = true;
        document.getElementById('elsewhere').focus();
      });
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

function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw).entries())));
  });
}

/** Where a POST goes: the right password signs in, a wrong one re-renders
 *  the same page; username-first and TOTP flows step forward. */
async function serveFixtures(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const port = (server.address() as net.AddressInfo).port;
    if (req.method === 'POST') {
      const body = await readBody(req);
      posts.push({ path: url.pathname, body });
      const redirect = (to: string) => { res.statusCode = 303; res.setHeader('location', to); res.end(); };
      switch (url.pathname) {
        case '/account':
          if (body.pw === PASSWORD) return redirect('/home');
          break;
        case '/mfa':
          if (body.pw === PASSWORD) return redirect('/mfa/otp');
          break;
        case '/signin': return redirect('/signin/password');
        case '/signin/password':
          if (body.pw === PASSWORD) return redirect('/home');
          break;
        case '/mfa/otp':
          if (/^\d{6}\d$/.test(body.code ?? '')) return redirect('/home');
          break;
        case '/signin/portal':
          if (body.pw === PASSWORD) return redirect('/home');
          break;
        case '/link': return redirect('/signin/sent');
        case '/signin/spa':
          if (body.pw === PASSWORD) return redirect('/home');
          break;
        case '/signin/steals':
          if (body.pw === PASSWORD) return redirect('/home');
          break;
      }
      // The wrong password: the same page, the form again.
      const again = PAGES[url.pathname];
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(again ? again(port) : 'nope');
      return;
    }
    const render = PAGES[url.pathname];
    if (!render) { res.statusCode = 404; res.end('nope'); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(render(port));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

interface LaunchedChromium { proc: ChildProcess; endpoint: string; userDataDir: string; exited: Promise<void> }

async function launchChromium(): Promise<LaunchedChromium> {
  const port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-login-'));
  const proc = spawn(chromium.executablePath(), [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--site-per-process', '--window-size=1280,800', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  const ep = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${ep}/json/version`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('chromium did not open its debugging port');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { proc, endpoint: ep, userDataDir, exited };
}

async function stopChromium(c: LaunchedChromium | null): Promise<void> {
  if (!c) return;
  c.proc.kill('SIGKILL');
  await c.exited;
  fs.rmSync(c.userDataDir, { recursive: true, force: true });
}

let fixtures: Awaited<ReturnType<typeof serveFixtures>>;
let chrome: LaunchedChromium | null = null;
let driver: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
const base = () => `http://127.0.0.1:${fixtures.port}`;

async function openPage(pathname: string): Promise<void> {
  const page = driver!.contexts()[0].pages()[0] ?? await driver!.contexts()[0].newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${base()}${pathname}`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 200));
}

const currentUrl = () => driver!.contexts()[0].pages()[0].url();

function newSession(threadId: string | null = 'th'): SessionState {
  store.session = {
    id: 'sid', tenantId: 't', threadId, invocationId: threadId ? null : 'inv-1', vendor: 'steel', vendorSessionId: endpoint, takeoverState: 'none', takenOverAt: null,
    callerSessionId: 'ui:1', agentId: 'a', closedAt: null, pageSnapshot: null, currentUrl: null, currentTitle: null, viewport: { width: 1280, height: 800 },
  };
  return store.session;
}

const matching = () => ({ vaultId: 'v1', itemId: 'i1', title: 'Fixture', websites: [], username: null });

beforeAll(async () => {
  fixtures = await serveFixtures();
});

afterAll(async () => {
  await fixtures.close();
});

beforeEach(async () => {
  store.reset();
  posts.length = 0;
  vault.available = true;
  vault.match = matching();
  vault.totp = null;
  vault.unusable = false;
  vault.passwordOnly = false;
  vault.resolveCalls = 0;
  _resetSavedLoginAttemptsForTesting();
  chrome = await launchChromium();
  endpoint = chrome.endpoint;
  driver = await chromium.connectOverCDP(chrome.endpoint);
  newSession();
});

afterEach(async () => {
  await _endAllSessionCaptures();
  await _closeCdpPool();
  await driver?.close().catch(() => undefined);
  driver = null;
  await stopChromium(chrome);
  chrome = null;
});

/** Every string the record carries, for the "no value anywhere" check. */
function recordedStrings(): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(store.activity);
  return out;
}

const steps: BrowserTaskStep[] = [];
const intoSteps = (step: BrowserTaskStep) => { steps.push(step); };

describe('the fill on a real page', () => {
  it('single step: the username and password are typed, the form submitted, the landing observed as confirmed, and no recorded string carries a value', async () => {
    await openPage('/account');
    const outcome = await applySavedLoginAfterNavigation('steel', endpoint, 't');
    expect(outcome).toBe('confirmed');
    // What the page received: the real values, through the form.
    expect(posts).toEqual([{ path: '/account', body: { user: USERNAME, pw: PASSWORD } }]);
    expect(currentUrl()).toBe(`${base()}/home`);
    // The pane's row: one, with the step, the control names and the masked
    // username, protected data omitted, the authentication class.
    expect(store.activity).toHaveLength(1);
    const row = store.activity[0] as { tool: string; outcome: string; steps: BrowserTaskStep[]; instruction: string };
    expect(row.tool).toBe('saved_login');
    expect(row.outcome).toBe('saved_login_confirmed');
    expect(row.steps).toHaveLength(1);
    expect(row.steps[0]).toMatchObject({ type: 'saved_login_confirmed', protectedDataOmitted: true, protectedKind: 'authentication' });
    expect(row.steps[0].action).toContain('Email · j…@a.test');
    expect(row.steps[0].action).toContain('Password');
    for (const s of recordedStrings()) {
      expect(s).not.toContain(PASSWORD);
      expect(s).not.toContain(USERNAME);
    }
    // The origin is remembered: a second navigation to it does not refill.
    await openPage('/account');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('none');
    expect(posts).toHaveLength(1);
    expect(store.activity).toHaveLength(1);
  });

  // HTML gives an input with no form owner no implicit submission, so a page
  // built out of components receives Enter and does nothing with it. The fill
  // sends such a page by clicking the control whose name says it sends.
  it('a sign-in page with no form element is sent by its button, not by Enter', async () => {
    await openPage('/signin/spa');
    const outcome = await applySavedLoginAfterNavigation('steel', endpoint, 't');
    expect(outcome).toBe('confirmed');
    expect(posts).toEqual([{ path: '/signin/spa', body: { user: USERNAME, pw: PASSWORD } }]);
    expect(currentUrl()).toBe(`${base()}/home`);
    for (const s of recordedStrings()) {
      expect(s).not.toContain(PASSWORD);
      expect(s).not.toContain(USERNAME);
    }
  });

  // A click names a place on the screen, and a page that takes focus back
  // as it settles leaves the box empty. The miss is retried against a
  // freshly measured box.
  it('a page that pulls focus away as it settles is filled on the retry', async () => {
    await openPage('/signin/steals');
    const outcome = await applySavedLoginAfterNavigation('steel', endpoint, 't');
    expect(outcome).toBe('confirmed');
    expect(posts).toEqual([{ path: '/signin/steals', body: { user: USERNAME, pw: PASSWORD } }]);
  });

  it('username-first: the username is submitted alone on the sign-in route, the password follows on the next page', async () => {
    await openPage('/signin');
    const outcome = await applySavedLoginAfterNavigation('steel', endpoint, 't');
    expect(outcome).toBe('confirmed');
    expect(posts).toEqual([
      { path: '/signin', body: { user: USERNAME } },
      { path: '/signin/password', body: { pw: PASSWORD } },
    ]);
    expect(currentUrl()).toBe(`${base()}/home`);
    const step = (store.activity[0] as { steps: BrowserTaskStep[] }).steps[0];
    expect(step.action).toContain('Email address · j…@a.test');
    expect(step.action).toContain('Password');
  });

  it('TOTP: the one-time code is read again at the moment the code box appears, filled and submitted', async () => {
    vault.totp = { code: '123456' };
    await openPage('/mfa');
    const outcome = await applySavedLoginAfterNavigation('steel', endpoint, 't');
    expect(outcome).toBe('confirmed');
    expect(posts[0]).toEqual({ path: '/mfa', body: { user: USERNAME, pw: PASSWORD } });
    // The second read's code, not the first's: it rotates.
    expect(vault.resolveCalls).toBe(2);
    expect(posts[1]).toEqual({ path: '/mfa/otp', body: { code: '1234562' } });
    expect(currentUrl()).toBe(`${base()}/home`);
    const step = (store.activity[0] as { steps: BrowserTaskStep[] }).steps[0];
    expect(step.action).toContain('One-time code');
    for (const s of recordedStrings()) expect(s).not.toContain('123456');
  });

  it('TOTP with no code: the password is submitted and the outcome is submitted, with the reason', async () => {
    vault.totp = { error: 'invalid otp secret' };
    await openPage('/mfa');
    const outcome = await applySavedLoginAfterNavigation('steel', endpoint, 't');
    expect(outcome).toBe('submitted');
    expect(posts).toHaveLength(1);
    expect(currentUrl()).toBe(`${base()}/mfa/otp`);
    const step = (store.activity[0] as { steps: BrowserTaskStep[] }).steps[0];
    expect(step.type).toBe('saved_login_submitted');
    expect(step.action).toContain('invalid otp secret');
  });

  it('a page that asks for the one-time code alone is answered from the item, and a code the item does not hold is the person\'s step', async () => {
    vault.totp = { code: '123456' };
    await openPage('/mfa/otp');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('confirmed');
    expect(posts).toEqual([{ path: '/mfa/otp', body: { code: '1234562' } }]);
    expect(currentUrl()).toBe(`${base()}/home`);
    const step = (store.activity[0] as { steps: BrowserTaskStep[] }).steps[0];
    expect(step.action).toBe('One-time code');

    // The same page, an item with no TOTP field: nothing typed, a skip that says why.
    _resetSavedLoginAttemptsForTesting();
    store.reset();
    newSession();
    posts.length = 0;
    vault.totp = null;
    await openPage('/mfa/otp');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('skipped');
    expect(posts).toHaveLength(0);
    const row = store.activity[0] as { outcome: string; steps: BrowserTaskStep[] };
    expect(row.outcome).toBe('saved_login_skipped');
    expect(row.steps[0].action).toContain('one-time code the 1Password item does not hold');
  });

  it('a code box declared `one-time-code webauthn` is answered with the code, never with the username', async () => {
    vault.totp = { code: '123456' };
    await openPage('/mfa/otp-webauthn');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('confirmed');
    // The code of the SECOND read: the fill reads it again at the moment the
    // box appears, because a code rotates every thirty seconds.
    expect(vault.resolveCalls).toBe(2);
    expect(posts).toEqual([{ path: '/mfa/otp', body: { code: '1234562' } }]);
    expect(currentUrl()).toBe(`${base()}/home`);
    for (const s of recordedStrings()) expect(s).not.toContain(USERNAME);
  });

  it('the site\'s own search box on a sign-in route never takes the username: the form the password is in decides', async () => {
    await openPage('/signin/portal');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('confirmed');
    // The search box was never typed into: one POST, to the sign-in form.
    expect(posts).toEqual([{ path: '/signin/portal', body: { user: USERNAME, pw: PASSWORD } }]);
    expect(currentUrl()).toBe(`${base()}/home`);
    const step = (store.activity[0] as { steps: BrowserTaskStep[] }).steps[0];
    expect(step.action).toContain('Email · j…@a.test');
    expect(step.action).not.toContain('Search');
  });

  it('an item that holds a password and an empty username types nothing: an empty value would clear the box and submit', async () => {
    vault.passwordOnly = true;
    await openPage('/account');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('skipped');
    expect(posts).toHaveLength(0);
    const row = store.activity[0] as { steps: BrowserTaskStep[] };
    expect(row.steps[0].action).toContain('no username and password');
  });

  it('a page with a search box and no sign-in form is left alone: nothing typed, nothing recorded', async () => {
    await openPage('/search');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('none');
    expect(posts).toHaveLength(0);
    expect(store.activity).toHaveLength(0);
    expect(vault.resolveCalls).toBe(0);
  });

  it('a sign-in form inside a same-origin frame is found and filled', async () => {
    await openPage('/framed');
    const outcome = await applySavedLoginAfterNavigation('steel', endpoint, 't');
    expect(outcome).toBe('confirmed');
    expect(posts).toEqual([{ path: '/account', body: { user: USERNAME, pw: PASSWORD } }]);
    // The frame signed in; the top page stayed.
    expect(currentUrl()).toBe(`${base()}/framed`);
  });

  it('failed: a password box visible again at the same URL, and no retry on that origin for the session', async () => {
    // The fixture accepts one password; make the vault hold another.
    vault.match = { ...matching(), itemId: 'wrong' };
    const realResolve = jest.requireMock('../logins').resolveLogin;
    jest.requireMock('../logins').resolveLogin = async () => ({ username: USERNAME, password: 'not-it' });
    try {
      await openPage('/account');
      const outcome = await applySavedLoginAfterNavigation('steel', endpoint, 't');
      expect(outcome).toBe('failed');
      expect(posts).toEqual([{ path: '/account', body: { user: USERNAME, pw: 'not-it' } }]);
      expect(currentUrl()).toBe(`${base()}/account`);
      expect((store.activity[0] as { outcome: string }).outcome).toBe('saved_login_failed');
      await openPage('/account');
      expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('none');
      expect(posts).toHaveLength(1);
      expect(_attemptedOriginsForTesting('sid').get(base())).toBe('failed');
    } finally {
      jest.requireMock('../logins').resolveLogin = realResolve;
    }
  });

  it('submitted: the form went to a page still on the sign-in route, with no form on it', async () => {
    await openPage('/link');
    const outcome = await applySavedLoginAfterNavigation('steel', endpoint, 't');
    expect(outcome).toBe('submitted');
    expect(currentUrl()).toBe(`${base()}/signin/sent`);
    expect((store.activity[0] as { outcome: string }).outcome).toBe('saved_login_submitted');
  });

  it('two saved logins match, on the sign-in page: nothing is typed, a skipped step is recorded, and on the pane the person is asked to take over', async () => {
    vault.match = 'ambiguous';
    await openPage('/account');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('skipped');
    expect(posts).toHaveLength(0);
    expect(vault.resolveCalls).toBe(0);
    const row = store.activity[0] as { outcome: string; steps: BrowserTaskStep[] };
    expect(row.outcome).toBe('saved_login_skipped');
    expect(row.steps[0].action).toContain('two saved logins match');
    expect(store.interventions).toHaveLength(1);
    expect(store.interventions[0]).toMatchObject({ sessionId: 'sid', threadId: 'th' });
    // Recorded once for the origin.
    await openPage('/account');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('none');
    expect(store.activity).toHaveLength(1);
    expect(store.interventions).toHaveLength(1);
  });

  it('two saved logins match, on a page of the site that is not a sign-in page: nothing is recorded and nobody is asked', async () => {
    vault.match = 'ambiguous';
    await openPage('/search');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('none');
    expect(store.activity).toHaveLength(0);
    expect(store.interventions).toHaveLength(0);
    // The sign-in page of the same site, reached later, is where the person is asked.
    await openPage('/account');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('skipped');
    expect(store.interventions).toHaveLength(1);
  });

  it('an item with no username and password pair is skipped with that reason, and nothing is typed', async () => {
    vault.unusable = true;
    await openPage('/account');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('skipped');
    expect(posts).toHaveLength(0);
    const row = store.activity[0] as { steps: BrowserTaskStep[] };
    expect(row.steps[0].action).toContain('no username and password');
  });

  it('while an action holds the session, the fill after a navigation stands down rather than type over it', async () => {
    await openPage('/account');
    const release = holdPaneAction('sid')!;
    expect(release).not.toBeNull();
    try {
      expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('none');
      expect(posts).toHaveLength(0);
      expect(store.activity).toHaveLength(0);
    } finally {
      release();
    }
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('confirmed');
    expect(posts).toHaveLength(1);
  });

  it('a workspace without the connector pays nothing: no walk, no read, no record', async () => {
    vault.available = false;
    await openPage('/account');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('none');
    expect(posts).toHaveLength(0);
    expect(store.activity).toHaveLength(0);
  });

  it('on a run-owned session the step is parked for the task rather than written as a pane row, and the task page path hands the step to its caller', async () => {
    newSession(null);
    await openPage('/account');
    expect(await applySavedLoginAfterNavigation('steel', endpoint, 't')).toBe('confirmed');
    expect(store.activity).toHaveLength(0);
    const { takePendingLoginSteps } = await import('../autofill');
    const parked = takePendingLoginSteps(endpoint);
    expect(parked).toHaveLength(1);
    expect(parked[0].type).toBe('saved_login_confirmed');
    expect(takePendingLoginSteps(endpoint)).toEqual([]);

    // The same fill, on the page a task holds, with the step handed over.
    _resetSavedLoginAttemptsForTesting();
    posts.length = 0;
    steps.length = 0;
    await openPage('/account');
    const page = driver!.contexts()[0].pages()[0];
    const outcome = await applySavedLogin(sessionOf() as never, 't', intoSteps, { page });
    expect(outcome).toBe('confirmed');
    expect(steps).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });

  it('on the pane path the page in hand is used', async () => {
    await openPage('/account');
    const page = driver!.contexts()[0].pages()[0];
    expect(await applySavedLoginOnPane(sessionOf() as never, 't', page)).toBe('confirmed');
    expect(posts).toHaveLength(1);
    expect(store.activity).toHaveLength(1);
  });
});
