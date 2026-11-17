// The Jev loop against real Chromium over CDP, with the vendor's answers
// REPLAYED from a scripted policy: the loop never touches the vendor here.
//
// The reference's local guard checks (jev-ultrafast scripts/check_guards.py)
// are ported first: a moved target is clicked at its current location, an
// unrelated off-screen change does not invalidate, the listed mutations do,
// a textless overlay blocks the click before input, native controls expose
// only supported operations and safe values, a native select executes, real
// text replaces a field's contents and waits for combobox suggestions, and a
// navigation invalidates the old document.
//
// Then the loop end to end: a login form; a search with an autocomplete
// combobox; a multi-step form with a native select and a cookie banner; a
// page that re-renders between observe and act (stale → re-observe, no double
// click); a control covered by an overlay; three no-change actions → blocked;
// text not in the task → its handoff with the clock; iframe-only, file input
// and new-tab pages → their reasons; a prompt carrying protected values
// leaves none of them in the result or the trail; no action before the usage
// post for its decision is acknowledged; a failed post → unavailable; a task
// ending in DONE makes exactly one goal check, acknowledged before completed.

import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from 'playwright-core';

jest.mock('../../../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../../agent-lifecycle/resolve-runtime-agent-id', () => ({ resolveInternalAgentId: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../../platform-callback/client', () => ({ getPlatformCallbackClient: jest.fn() }));
jest.mock('../../../../integrations/web-fetch/web-tool-secrets', () => ({ getWebToolSecret: jest.fn().mockResolvedValue('key') }));

// The injection screen the loop runs on each observation. The loop's own
// vendor calls go through `_setLoopAskForTesting`, a different seam, so
// mocking `ask` here isolates the SCREEN's calls and leaves the loop's
// decisions replayed as before. The rest of `screenUntrustedText` is real,
// which is the point: its gate, its size floor and its dedupe are what decide
// whether an observation costs a request.
const mockSemanticAsk = jest.fn();
jest.mock('../../../../typesafe/client', () => ({
  ask: (...a: unknown[]) => mockSemanticAsk(...a),
  DEFAULT_ATTEMPT_TIMEOUT_MS: 25_000,
}));
jest.mock('../../../../entitlements-client/service', () => ({
  isFeatureEnabled: jest.fn(async (_t: string, key: string) => key === 'injection_detection'),
}));
jest.mock('../../../../audit', () => ({ insertAuditLog: jest.fn().mockResolvedValue(undefined) }));

import { observe } from '../observe';
import { fresh, act, SelectNotConfirmed } from '../act';
import { StalePage } from '../observe';
import { runJevLoop, _setPageOpenerForTesting } from '../loop';
import { _setLoopAskForTesting } from '../client';
import { _resetSemanticDedupeForTesting } from '../../../../injection-detection/finding';
import { UNTRUSTED_CONTENT_SET, type QuestionSet } from '../../../../typesafe/questions';
import type { AskResult } from '../../../../typesafe/client';
import type { Questions } from '@typesafe-ai/sdk';

/** The run the screen deduplicates within. */
const INVOCATION = '44444444-4444-4444-8444-444444444444';

// ── Chromium ────────────────────────────────────────────────────────────────

interface LaunchedChromium { proc: ChildProcess; endpoint: string; userDataDir: string; exited: Promise<void> }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address() as net.AddressInfo; srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function launchChromium(): Promise<LaunchedChromium> {
  const port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-loop-'));
  const proc = spawn(chromium.executablePath(), [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--site-per-process', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { const res = await fetch(`${endpoint}/json/version`); if (res.ok) break; } catch { /* not up yet */ }
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

// ── Fixture pages ───────────────────────────────────────────────────────────

const html = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>${head}</head><body style="margin:30px">${body}</body></html>`;

const PAGES: Record<string, string> = {
  '/guards': html(`
    <style>button{width:180px;height:50px}#outside{position:absolute;top:3000px}</style>
    <p id="context">Cart total: $10</p>
    <button id="target" onclick="window.clicks=(window.clicks||0)+1">Continue</button>
    <label>City<input id="field" value="Zurich"></label>
    <label><input id="toggle" type="checkbox">Refundable</label>
    <select aria-label="Category"><option>All</option><option>Design</option></select>
    <p id="outside">Unrelated offscreen text</p>`),
  '/login': html(`
    <h1>Sign in</h1>
    <form onsubmit="event.preventDefault(); document.body.innerHTML='<h1>Welcome back, '+document.getElementById('user').value+'</h1><p>Signed in</p>'">
      <label>Username <input id="user"></label>
      <label>Password <input id="pw" type="password"></label>
      <button type="submit" id="submit">Sign in</button>
    </form>`),
  '/search': html(`
    <label>Search <input id="q" role="combobox" aria-controls="suggestions" aria-expanded="false"></label>
    <div role="listbox" id="suggestions"></div>
    <div id="results"></div>
    <script>
      const q=document.getElementById('q');
      q.addEventListener('input',()=>setTimeout(()=>{
        document.getElementById('suggestions').innerHTML='<div role="option" id="opt" tabindex="0">Zurich hotels</div>';
        document.getElementById('opt').addEventListener('click',()=>{ document.getElementById('results').innerHTML='<h2>Results for Zurich hotels</h2><p>3 hotels found</p>'; document.getElementById('suggestions').innerHTML=''; });
      },60));
    </script>`),
  '/form': html(`
    <div id="banner" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:10px">We use cookies <button id="accept" onclick="document.getElementById('banner').remove()">Accept</button></div>
    <form onsubmit="event.preventDefault(); document.body.innerHTML='<h1>Booked: '+document.getElementById('cat').value+'</h1>'">
      <label>Category <select id="cat"><option>All</option><option>Design</option><option>Coastal</option></select></label>
      <button type="submit" id="book">Book</button>
    </form>`),
  '/rerender': html(`
    <button id="a" onclick="window.clicks=(window.clicks||0)+1">Continue</button>
    <script>
      // Replaces the button the moment the loop has observed it, once.
      window.addEventListener('load',()=>{ window.__rerender = () => { const b=document.getElementById('a'); b.outerHTML=b.outerHTML; }; });
    </script>`),
  '/overlay': html(`
    <button id="target" onclick="window.clicks=(window.clicks||0)+1">Continue</button>
    <div id="cover" style="position:fixed;inset:0;z-index:9999;background:white"></div>`),
  '/nochange': html(`<button id="noop">Noop</button><p>Nothing happens here</p>`),
  // The same no-change page with enough prose to clear the screen's size
  // floor, so the screen actually runs on it and its dedupe is exercised.
  '/steadyprose': html(`<button id="noop">Noop</button>
    <p>Northwind Supply publishes its standard payment terms here. Terms are net thirty days from the
    invoice date, late payment carries interest at two per cent per month, and disputes must be raised
    within fourteen days of the invoice being issued. These terms were last reviewed in January and
    apply to every supplier account unless a signed agreement says otherwise.</p>`),
  '/needstext': html(`<label>Comment <textarea id="c"></textarea></label><button id="send">Send</button>`),
  '/frames': html(`<iframe src="/inner" style="width:400px;height:200px"></iframe>`),
  '/inner': html(`<button>Inside</button>`),
  '/file': html(`<label>Upload <input type="file" id="f"></label>`),
  '/newtab': html(`<a href="/inner" target="_blank" id="open">Open in new tab</a>`),
  '/done': html(`<h1>Order confirmed</h1><p>Your order 4412 is confirmed.</p><button id="x">Close</button>`),
};

function startServer(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const body = PAGES[req.url ?? '/'];
    if (!body) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

// ── The replayed policy ─────────────────────────────────────────────────────

type Answer = { choice: string; confidence: number; probabilities: Record<string, number> };
const pick = (ids: string[], id: string): Answer => ({ choice: id, confidence: 1, probabilities: Object.fromEntries(ids.map((i) => [i, i === id ? 1 : 0])) });

interface ObservedRequest { setId: string; state: unknown; questions: Record<string, unknown> }
interface Policy {
  /** Given the request, the answers. Return undefined to answer null (unavailable). */
  answer: (req: ObservedRequest, n: number) => Record<string, Answer | { type: 'noul'; noul: number }> | undefined;
  /** Whether the usage post for this request is acknowledged. */
  posted?: (n: number) => boolean;
  /** A hook between the request and the answer, to mutate the page. */
  before?: (n: number) => Promise<void>;
}

const requests: ObservedRequest[] = [];
let actedBeforePost = false;
let clicksAtRequest = 0;
let pageForPolicy: Page | null = null;

function installPolicy(policy: Policy) {
  requests.length = 0;
  actedBeforePost = false;
  _setLoopAskForTesting(async <Q extends Questions>(set: QuestionSet<Q>, state: unknown): Promise<AskResult<Q> | null> => {
    const n = requests.length;
    requests.push({ setId: set.id, state, questions: set.questions as Record<string, unknown> });
    if (pageForPolicy) clicksAtRequest = await pageForPolicy.evaluate('window.clicks||0').catch(() => 0) as number;
    if (policy.before) await policy.before(n);
    const answers = policy.answer(requests[n], n);
    // The usage post is inside `ask`: nothing may act until it returns.
    await new Promise((r) => setTimeout(r, 30));
    if (pageForPolicy) {
      const clicksNow = await pageForPolicy.evaluate('window.clicks||0').catch(() => 0) as number;
      if (clicksNow !== clicksAtRequest) actedBeforePost = true;
    }
    if (answers === undefined || (policy.posted && !policy.posted(n))) return null;
    return { answers: answers as never, model: set.model, usage: { inputTokens: 100, outputTokens: 0 }, callId: `c${n}`, attempts: 1, latencyMs: 5 };
  });
}

/** Choose the operation and target by the control's label. */
function byLabel(req: ObservedRequest, operation: string, labelIncludes: string, valueId?: string) {
  const opQ = req.questions.operation as { criteria: Record<string, unknown> };
  const ops = Object.keys(opQ.criteria);
  const answers: Record<string, Answer> = { operation: pick(ops, operation) };
  const headName = `${operation.toLowerCase()}_target`;
  const head = req.questions[headName] as { criteria: Record<string, { element: string }> } | undefined;
  if (head) {
    const ids = Object.keys(head.criteria);
    const id = ids.find((i) => head.criteria[i].element.includes(labelIncludes)) ?? ids[0];
    answers[headName] = pick(ids, id);
  }
  const value = req.questions.type_text_value as { criteria: Record<string, unknown> } | undefined;
  if (value) {
    const ids = Object.keys(value.criteria);
    answers.type_text_value = pick(ids, valueId ?? 'none');
  }
  return answers;
}
function control(req: ObservedRequest, operation: string) {
  const opQ = req.questions.operation as { criteria: Record<string, unknown> };
  return { operation: pick(Object.keys(opQ.criteria), operation) } as Record<string, Answer>;
}
const goalMet = (p: number) => ({ goal_met: { type: 'noul' as const, noul: p } });

// ── Harness ─────────────────────────────────────────────────────────────────

let chrome: LaunchedChromium | null = null;
let server: http.Server;
let base = '';
let browser: Browser;
let context: BrowserContext;

beforeAll(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  chrome = await launchChromium();
  browser = await chromium.connectOverCDP(chrome.endpoint);
  context = browser.contexts()[0] ?? await browser.newContext();
});
afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await stopChromium(chrome);
  await new Promise<void>((r) => server.close(() => r()));
  _setLoopAskForTesting(null);
  _setPageOpenerForTesting(null);
});

async function openFixture(route: string): Promise<{ page: Page; cdp: CDPSession }> {
  const page = await context.newPage();
  await page.goto(`${base}${route}`, { waitUntil: 'load' });
  const cdp = await context.newCDPSession(page);
  return { page, cdp };
}

function runOn(page: Page, cdp: CDPSession, prompt: string, parameters?: Record<string, unknown>, invocationId?: string) {
  pageForPolicy = page;
  _setPageOpenerForTesting(async () => ({ page, context, cdp, close: async () => { await cdp.detach().catch(() => undefined); } }));
  return runJevLoop({ cdpUrl: 'test', prompt, parameters, tenantId: 't1', ...(invocationId ? { invocationId } : {}) }, { deadlineAt: Date.now() + 60_000 });
}

// ── The reference's guard checks ────────────────────────────────────────────

describe('the reference guard checks, ported', () => {
  it('runs them all', async () => {
    const { page, cdp } = await openFixture('/guards');
    try {
      let state = await observe(page);
      const cont = state.actions.find((a) => a.label === 'Continue')!;
      await page.evaluate(`document.querySelector('#target').style.transform='translateX(200px)'`);
      expect(await fresh(page, state)).toBe(true);
      await act(page, cdp, state, cont, null);
      expect(await page.evaluate('window.clicks')).toBe(1);

      await page.evaluate(`document.querySelector('#outside').textContent='Updated outside the viewport'`);
      expect(await fresh(page, state)).toBe(true);

      const mutations: Record<string, string> = {
        'visible context': `document.querySelector('#context').textContent='Cart total: $100'`,
        'accessible label': `document.querySelector('#target').setAttribute('aria-label','Delete account')`,
        'field property': `document.querySelector('#field').value='London'`,
        'checkbox property': `document.querySelector('#toggle').checked=true`,
        'disabled target': `document.querySelector('#target').disabled=true`,
        'read-only field': `document.querySelector('#field').readOnly=true`,
        'hidden target': `document.querySelector('#target').style.display='none'`,
        'replaced node': `document.querySelector('#target').outerHTML=document.querySelector('#target').outerHTML`,
        'dropdown option': `document.querySelector('select').options[1].text='Coastal'`,
      };
      for (const [label, expression] of Object.entries(mutations)) {
        await page.evaluate(`document.querySelector('#target').style.display='block'; document.querySelector('#target').disabled=false`);
        state = await observe(page);
        await page.evaluate(expression);
        expect({ label, fresh: await fresh(page, state) }).toEqual({ label, fresh: false });
      }

      // A textless overlay does not alter the semantic state but blocks the click.
      await page.evaluate(`document.querySelector('#target').disabled=false; document.querySelector('#target').style.display='block'`);
      state = await observe(page);
      const target = state.actions.find((a) => a.label === 'Delete account')!;
      await page.evaluate(`const cover=document.createElement('div'); cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white'; document.body.append(cover)`);
      expect(await fresh(page, state)).toBe(true);
      await expect(act(page, cdp, state, target, null)).rejects.toBeInstanceOf(StalePage);
      expect(await page.evaluate('window.clicks')).toBe(1);

      await page.evaluate(`document.body.innerHTML=${JSON.stringify(`
        <form><p id="price">Total $10</p>
        <button type="button" id="buy">Buy</button>
        <label>Search <input id="query" role="combobox" aria-controls="suggestions"></label>
        <div role="listbox" id="suggestions"></div>
        <label><input id="check" type="checkbox">Enabled</label>
        <label><input id="radio" type="radio">Choice</label>
        <input id="readonly" aria-label="Read only" readonly>
        <input id="secret" type="password" value="never expose this">
        <button id="off" disabled>Disabled</button>
        <select id="category" aria-label="Category">
          <option>All</option><option>Design</option><option disabled>Unavailable</option>
        </select></form><aside id="unrelated">News</aside>`)}`);
      state = await observe(page);
      let buy = state.actions.find((a) => a.label === 'Buy')!;
      await page.evaluate(`document.querySelector('#unrelated').textContent='New unrelated news'`);
      expect(await fresh(page, state, buy)).toBe(true);
      expect(await fresh(page, state)).toBe(false);
      for (const [label, expression] of Object.entries({
        'nearby price': `document.querySelector('#price').textContent='Total $100'`,
        'form value': `document.querySelector('#query').value='changed'`,
        'form toggle': `document.querySelector('#check').checked=true`,
        'target replacement': `document.querySelector('#buy').outerHTML=document.querySelector('#buy').outerHTML`,
      })) {
        state = await observe(page);
        buy = state.actions.find((a) => a.label === 'Buy')!;
        await page.evaluate(expression);
        expect({ label, fresh: await fresh(page, state, buy) }).toEqual({ label, fresh: false });
      }

      state = await observe(page);
      const actions = state.actions;
      for (const role of ['checkbox', 'radio']) {
        expect(new Set(actions.filter((a) => a.role === role).map((a) => a.kind))).toEqual(new Set(['click']));
      }
      expect(new Set(actions.filter((a) => a.label === 'Read only').map((a) => a.kind))).toEqual(new Set(['click']));
      expect(actions.some((a) => a.label === 'Disabled' || a.value === 'never expose this')).toBe(false);
      expect(actions.filter((a) => a.kind === 'select').map((a) => a.value)).toEqual(['Design']);

      const select = actions.find((a) => a.kind === 'select')!;
      await act(page, cdp, state, select, null);
      expect(await page.evaluate(`document.querySelector('#category').value`)).toBe('Design');

      await page.evaluate(`document.querySelector('#query').addEventListener('input',()=>setTimeout(()=>{ document.querySelector('#suggestions').innerHTML='<div role=option>Generated</div>' },60))`);
      state = await observe(page);
      const field = state.actions.find((a) => a.kind === 'fill')!;
      await act(page, cdp, state, field, 'Generated');
      state = await observe(page, field);
      expect(await page.evaluate(`document.querySelector('#query').value`)).toBe('Generated');
      expect(state.actions.some((a) => a.role === 'option')).toBe(true);

      await page.goto('about:blank');
      expect(await fresh(page, state, field)).toBe(false);
      void SelectNotConfirmed;
    } finally {
      await cdp.detach().catch(() => undefined);
      await page.close();
    }
  });
});

// ── The loop end to end ─────────────────────────────────────────────────────

describe('the loop', () => {
  it('fills a login form from the task\'s literals and verifies completion with one goal check', async () => {
    const { page, cdp } = await openFixture('/login');
    installPolicy({
      answer: (req, n) => {
        if (req.setId === 'browser_goal_check') return goalMet(0.95);
        const text = (req.state as { page: { text: string } }).page.text;
        if (text.includes('Welcome back')) return control(req, 'DONE');
        if (n === 0) return byLabel(req, 'TYPE_TEXT', 'Username', 'l1');
        return byLabel(req, 'CLICK', 'Sign in');
      },
    });
    const out = await runOn(page, cdp, 'Sign in as "jane" and confirm the welcome page');
    expect('outcome' in out).toBe(true);
    if ('outcome' in out) {
      expect(out.outcome.result.completed).toBe(true);
      expect(out.outcome.result.message).toBe('Browser task completed');
      expect(out.outcome.result.final.text).toContain('Welcome back, jane');
      expect(out.outcome.trail.steps.map((s) => s.type)).toEqual(['TYPE_TEXT', 'CLICK', 'DONE']);
      expect(out.outcome.trail.steps[0].action).toContain('textbox');
      // The literal is never in the trail or the message; the probability is.
      expect(JSON.stringify(out.outcome.trail)).not.toContain('jane');
      expect(out.outcome.trail.steps[2].probability).toBe(0.95);
    }
    expect(requests.filter((r) => r.setId === 'browser_goal_check')).toHaveLength(1);
    expect(actedBeforePost).toBe(false);
    await page.close();
  });

  it('a DONE below GOAL_T is unverified: success, completed false, the final observation attached', async () => {
    const { page, cdp } = await openFixture('/done');
    installPolicy({ answer: (req) => (req.setId === 'browser_goal_check' ? goalMet(0.2) : control(req, 'DONE')) });
    const out = await runOn(page, cdp, 'Confirm the order');
    if ('outcome' in out) {
      // A task that RAN but could not be confirmed says which of the two it
      // was: "stopped" alone reads as "nothing happened", and the model told
      // a person exactly that about a task that had acted.
      expect(out.outcome.result).toMatchObject({ success: true, completed: false, reason: 'unverified' });
      expect(out.outcome.result.message).toContain('could not confirm');
      expect(out.outcome.result.final.text).toContain('Order confirmed');
    } else { throw new Error('expected an outcome'); }
    await page.close();
  });

  it('a search with an autocomplete combobox: the wait lets the suggestion arrive before the next decision', async () => {
    const { page, cdp } = await openFixture('/search');
    installPolicy({
      answer: (req, n) => {
        if (req.setId === 'browser_goal_check') return goalMet(0.9);
        const text = (req.state as { page: { text: string } }).page.text;
        if (text.includes('3 hotels found')) return control(req, 'DONE');
        if (n === 0) return byLabel(req, 'TYPE_TEXT', 'Search', 'l1');
        return byLabel(req, 'CLICK', 'Zurich hotels');
      },
    });
    const out = await runOn(page, cdp, 'Search for "Zurich hotels" and open the results');
    expect('outcome' in out && out.outcome.result.completed).toBe(true);
    // The second request saw the suggestion as a control.
    const second = requests[1].questions.click_target as { criteria: Record<string, { element: string }> };
    expect(Object.values(second.criteria).some((c) => c.element.includes('Zurich hotels'))).toBe(true);
    await page.close();
  });

  it('a multi-step form with a native select and a cookie banner', async () => {
    const { page, cdp } = await openFixture('/form');
    installPolicy({
      answer: (req, n) => {
        if (req.setId === 'browser_goal_check') return goalMet(0.9);
        const text = (req.state as { page: { text: string } }).page.text;
        if (text.includes('Booked: Coastal')) return control(req, 'DONE');
        if (n === 0) return byLabel(req, 'CLICK', 'Accept');
        if (n === 1) return byLabel(req, 'SELECT', 'Coastal');
        return byLabel(req, 'CLICK', 'Book');
      },
    });
    const out = await runOn(page, cdp, 'Accept cookies, choose the Coastal category and book');
    expect('outcome' in out && out.outcome.result.completed).toBe(true);
    if ('outcome' in out) expect(out.outcome.trail.steps.map((s) => s.type)).toEqual(['CLICK', 'SELECT', 'CLICK', 'DONE']);
    await page.close();
  });

  it('a page that re-renders between observe and act: stale → re-observe, no double click', async () => {
    const { page, cdp } = await openFixture('/rerender');
    installPolicy({
      before: async (n) => { if (n === 0) await page.evaluate('window.__rerender()'); },
      answer: (req, n) => {
        if (req.setId === 'browser_goal_check') return goalMet(0.9);
        if (n <= 1) return byLabel(req, 'CLICK', 'Continue');
        return control(req, 'DONE');
      },
    });
    await runOn(page, cdp, 'Press continue');
    expect(await page.evaluate('window.clicks||0')).toBe(1);
    expect(requests.filter((r) => r.setId === 'browser_step')).toHaveLength(3);
    await page.close();
  });

  it('a control covered by an overlay: the hit-test rejects, the loop re-observes', async () => {
    const { page, cdp } = await openFixture('/overlay');
    installPolicy({
      answer: (req, n) => {
        if (n === 0) return byLabel(req, 'CLICK', 'Continue');
        return control(req, 'BLOCKED');
      },
    });
    const out = await runOn(page, cdp, 'Press continue');
    expect(await page.evaluate('window.clicks||0')).toBe(0);
    expect('handoff' in out && out.handoff.reason).toBe('blocked');
    await page.close();
  });

  it('three no-change actions → blocked handoff', async () => {
    const { page, cdp } = await openFixture('/nochange');
    installPolicy({ answer: (req) => byLabel(req, 'CLICK', 'Noop') });
    const out = await runOn(page, cdp, 'Make something happen');
    expect('handoff' in out && out.handoff.reason).toBe('blocked');
    if ('handoff' in out) expect(out.handoff.trail.steps.map((s) => s.type)).toEqual(['CLICK', 'CLICK', 'CLICK', 'handoff']);
    await page.close();
  });

  it('screens each observation\'s page text once per content hash, not once per element', async () => {
    // `observe` returns the observation and `decide` sends its text straight to
    // the vendor, with no `frameUntrusted` between them — so without the loop's
    // own call this page's text is the one untrusted surface in the estate
    // nothing looks at. Three no-change clicks: three decisions, three
    // observations of the SAME page, and one screen.
    _resetSemanticDedupeForTesting();
    mockSemanticAsk.mockReset();
    mockSemanticAsk.mockResolvedValue({
      answers: { content_kind: { choice: 'ordinary', probabilities: { ordinary: 1, addresses_reader: 0, external_directive: 0, sensitive_data_directive: 0 } } },
      model: UNTRUSTED_CONTENT_SET.model,
      usage: { inputTokens: 10, outputTokens: 0 },
      callId: 'screen-1',
      attempts: 1,
      latencyMs: 1,
    });

    const { page, cdp } = await openFixture('/steadyprose');
    installPolicy({ answer: (req) => byLabel(req, 'CLICK', 'Noop') });
    const out = await runOn(page, cdp, 'Make something happen', undefined, INVOCATION);
    expect('handoff' in out && out.handoff.reason).toBe('blocked');
    // The screen is fire-and-forget; let the last one settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(mockSemanticAsk).toHaveBeenCalledTimes(1);
    const [set, state, opts] = mockSemanticAsk.mock.calls[0];
    expect((set as { id: string }).id).toBe('untrusted_content');
    expect((opts as { tenantId: string; invocationId?: string })).toEqual(
      expect.objectContaining({ tenantId: 't1', invocationId: INVOCATION }),
    );
    // The whole page's text, not one control's label: the screen reads what the
    // model is about to read.
    const screened = (state as { content: string }).content;
    expect(screened).toContain('net thirty days from the');
    expect(screened).toContain('Northwind Supply');
    await page.close();
  });

  it('text the task did not supply → text_not_in_task handoff with the clock and the trail so far', async () => {
    const { page, cdp } = await openFixture('/needstext');
    installPolicy({ answer: (req) => byLabel(req, 'TYPE_TEXT', 'Comment', 'none') });
    const out = await runOn(page, cdp, 'Write a comment and send it');
    expect('handoff' in out && out.handoff.reason).toBe('text_not_in_task');
    if ('handoff' in out) {
      expect(out.handoff.trail.steps.map((s) => s.type)).toEqual(['handoff']);
      expect(out.handoff.final?.text).toContain('Comment');
    }
    await page.close();
  });

  it('iframe-only, file input and new-tab pages → their handoff reasons', async () => {
    let f = await openFixture('/frames');
    installPolicy({ answer: (req) => control(req, 'BLOCKED') });
    let out = await runOn(f.page, f.cdp, 'Press inside');
    expect('handoff' in out && out.handoff.reason).toBe('frame_only');
    await f.page.close();

    f = await openFixture('/file');
    installPolicy({ answer: (req) => control(req, 'BLOCKED') });
    out = await runOn(f.page, f.cdp, 'Upload the file');
    expect('handoff' in out && out.handoff.reason).toBe('file_input');
    await f.page.close();

    f = await openFixture('/newtab');
    installPolicy({ answer: (req, n) => (n === 0 ? byLabel(req, 'CLICK', 'Open in new tab') : control(req, 'DONE')) });
    out = await runOn(f.page, f.cdp, 'Open the link');
    expect('handoff' in out && out.handoff.reason).toBe('new_page');
    for (const p of context.pages()) if (p !== f.page && p.url().endsWith('/inner')) await p.close();
    await f.page.close();
  });

  it('a prompt carrying protected values leaves none of them in the result or the trail', async () => {
    const { page, cdp } = await openFixture('/login');
    installPolicy({
      answer: (req, n) => {
        if (req.setId === 'browser_goal_check') return goalMet(0.9);
        if (n === 0) return byLabel(req, 'TYPE_TEXT', 'Username', 'l1');
        return control(req, 'DONE');
      },
    });
    const out = await runOn(page, cdp, 'Sign in as "jane" with password "Hunter2!" email jane@example.com phone +41 79 123 45 67 card 4111 1111 1111 1111');
    const text = JSON.stringify('outcome' in out ? { result: { ...out.outcome.result, final: undefined }, trail: out.outcome.trail } : out);
    for (const secret of ['Hunter2!', 'jane@example.com', '79 123 45 67', '4111 1111 1111 1111']) expect(text).not.toContain(secret);
    await page.close();
  });

  it('a failed usage post hands off with reason unavailable', async () => {
    const { page, cdp } = await openFixture('/login');
    installPolicy({ answer: (req) => byLabel(req, 'TYPE_TEXT', 'Username', 'l1'), posted: () => false });
    const out = await runOn(page, cdp, 'Sign in as "jane"');
    expect('handoff' in out && out.handoff.reason).toBe('unavailable');
    expect(await page.evaluate(`document.getElementById('user').value`)).toBe('');
    await page.close();
  });
});
