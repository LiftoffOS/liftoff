// Telling a page that is working from a page that is finished.
//
// The loop's wait answered one bit: did anything change. A render in progress
// and a dead end both answer no, and they need opposite responses — leave the
// first alone, stop waiting on the second. Answered as one bit they are the
// same answer, which is how a ten-minute run spent its whole wait ladder on a
// page that was busy and then reported nothing.
//
// Four pages, four verdicts. The one that matters most is `working`: it is what
// lets a wait on a two-minute render not count against the ladder.

import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

jest.mock('../../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { observe } from '../observe';
import { fence } from '../fence';

interface Launched { proc: ChildProcess; endpoint: string; userDataDir: string; exited: Promise<void> }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address() as net.AddressInfo; srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function launchChromium(): Promise<Launched> {
  const port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-'));
  const proc = spawn(chromium.executablePath(), [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, 'about:blank',
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

const page = (body: string) => `<!doctype html><html><head><title>T</title></head><body style="margin:20px">${body}</body></html>`;

const PAGES: Record<string, string> = {
  // Nothing at all. A page that will not change by being waited on.
  '/still': page('<p>Nothing is happening here.</p><button id="b">Go</button>'),
  // A generator rendering: it keeps altering a progress line it is writing
  // into a node OUTSIDE the visible text budget, so the page's meaning does
  // not change while it works.
  '/rendering': page(`<p>Working.</p><div id="sink" style="position:absolute;top:5000px"></div><script>
    setInterval(() => { document.getElementById('sink').textContent = 'tick ' + Date.now(); }, 60);
  </script>`),
  // Churn that stops and achieves nothing: the page alters itself for a
  // moment, goes still, and means exactly what it meant before. A spinner that
  // never stops is NOT this — a spinner is the page saying it is working, and
  // the fence is right to call that `working`.
  //
  // Bounded by ELAPSED TIME, not by a tick count. Seven ticks at 40ms is 280ms
  // of churn, and the fence only sees it if `goto` plus `observe` finish inside
  // that — which is a race with page load, not a property of the fence. It lost
  // that race in CI at 3,103ms against 1,887ms locally and the page read
  // `quiet`, failing a deploy for a reason that had nothing to do with the
  // change in it.
  //
  // 600ms still stops well inside the 1,200ms budget `verdictFor` gives the
  // fence, so this is the same assertion — churn, then stillness, inside one
  // observation — with the start no longer having to win a race.
  '/churn': page(`<p>Loading.</p><div id="spin" style="position:absolute;top:5000px">.</div><script>
    let n = 0;
    const t0 = Date.now();
    const h = setInterval(() => {
      document.getElementById('spin').setAttribute('data-n', String(n += 1));
      if (Date.now() - t0 > 600) clearInterval(h);
    }, 40);
  </script>`),
  // A player pointed at a file that will never arrive: the element has a
  // source and no data, which is what a clip still being fetched looks like.
  '/loading-media': page('<p>Your video is on its way.</p><video id="v" src="/never-arrives.mp4"></video>'),
};

function startServer(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/never-arrives.mp4') {
      // Headers, then silence. The element stays at readyState 0 with a
      // source, which is exactly a file in flight.
      res.setHeader('content-type', 'video/mp4');
      res.writeHead(200);
      return;
    }
    const body = PAGES[url];
    if (!body) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

let chrome: Launched | null = null;
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
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  if (chrome) { chrome.proc.kill('SIGKILL'); await chrome.exited; fs.rmSync(chrome.userDataDir, { recursive: true, force: true }); }
  await new Promise<void>((r) => server.close(() => r()));
});

async function verdictFor(route: string, budgetMs = 1_200): Promise<string> {
  const p: Page = await context.newPage();
  await p.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
  const state = await observe(p);
  const verdict = await fence(p, state, budgetMs);
  await p.close();
  return verdict;
}

describe('the fence', () => {
  // The verdict the ladder does not count. A page rendering a video is not a
  // dead page, and a wait that found it working has not been wasted.
  it('says a page altering itself is working', async () => {
    expect(await verdictFor('/rendering')).toBe('working');
  });

  // A file on its way is the page working even when the DOM is completely
  // still, which is exactly the shape of a generator between "started" and
  // "ready".
  it('says a page fetching a file is working, with nothing moving in the DOM', async () => {
    expect(await verdictFor('/loading-media')).toBe('working');
  });

  // Churn that stopped and achieved nothing. Worth naming rather than calling
  // the page settled: something happened, and it was not progress, so waiting
  // more is pointless while the page is not inert either.
  it('calls churn that stops and changes nothing ambiguous', async () => {
    expect(await verdictFor('/churn')).toBe('ambiguous');
  });

  // Nothing happening. This is the one where waiting longer is the wrong move,
  // and the only one the old boolean could be right about.
  it('says a page doing nothing is quiet', async () => {
    expect(await verdictFor('/still')).toBe('quiet');
  });

  // The ordinary case: the page became a different page, which every other
  // part of the loop already agrees on through the same marker.
  it('says changed when the page becomes another page', async () => {
    const p = await context.newPage();
    await p.goto(`${base}/still`, { waitUntil: 'domcontentloaded' });
    const state = await observe(p);
    setTimeout(() => { void p.goto(`${base}/rendering`).catch(() => undefined); }, 100);
    expect(await fence(p, state, 4_000)).toBe('changed');
    await p.close();
  });
});
