// Getting a file out of a real browser, against real Chromium over CDP.
//
// A live run against a vendor is a slow check of this path — a long build, a
// chat, and a generator that may never finish — and when the bytes do not
// arrive it cannot say why. Everything
// below the vendor is one CDP page, which is what this drives — so the pipe
// can be proven in seconds, and the vendor differences (endpoint resolution)
// are the only part left to check anywhere else.
//
// Three pages, each a way this can fail:
//   /attachment  a server file behind the page's own download control
//   /blob        a file the page builds and revokes immediately (a generator)
//   /liar        an HTML error page served as clip.mp4
//
// The last one matters most. Nothing downstream re-checks what it was handed,
// so a file whose type came from its NAME is a file nobody checked.

import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// No database in this suite: the row is recorded elsewhere and proven
// elsewhere. What is under test is the browser half.
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(),
  getPool: jest.fn(() => ({ query: jest.fn() })),
}));

// The pool resolves a session's endpoint through the vendor proxy. Pointed at
// the local browser, every vendor's path below it is the same code.
let LOCAL_WS = '';
jest.mock('../session-vendor-proxy', () => ({
  cdpEndpointFor: async () => LOCAL_WS,
}));
// Arming a connection reads the session's row first, so there has to be one.
jest.mock('../repository', () => ({
  getByVendorSessionId: async () => ({
    id: 'sid', tenantId: '11111111-1111-4111-8111-111111111111',
    vendor: 'steel', vendorSessionId: 'local-session', closedAt: null,
  }),
}));

// The model-facing check is a separate claim, proven in its own suite. What
// is under test here is whether the BYTES are ever looked at.
jest.mock('../file-check', () => ({
  checkFetchedFile: jest.fn(async () => ({ looksRight: true, concern: '' })),
}));

import { keepDownloadBytes, fetchFileForSession, _clearKeptDownloads } from '../downloads';
import { withPage, _closeCdpPool } from '../cdp-page';

const TENANT = '11111111-1111-4111-8111-111111111111';
const VENDOR = 'steel';
const SESSION = 'local-session';
/** The session as the delivery path takes it. */
const SESSION_ROW = { id: 'sid', vendor: VENDOR, vendorSessionId: SESSION };

// A one-frame ISO base media file: the box length, `ftyp`, and a brand. Enough
// for a container check, which is the only claim being made about it.
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0, 0, 2, 0]),
  Buffer.from('isomiso2mp41', 'ascii'),
]);
const NOT_A_VIDEO = Buffer.from('<!doctype html><title>Rate limited</title><p>Too many requests.</p>', 'utf8');

// ── Chromium ────────────────────────────────────────────────────────────────

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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloads-'));
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

// ── The pages ───────────────────────────────────────────────────────────────

function startServer(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/attachment') {
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('content-disposition', 'attachment; filename="clip.mp4"');
      res.end(MP4);
      return;
    }
    if (url === '/liar') {
      // The type a page CLAIMS, over bytes that are nothing of the kind. Served
      // as an attachment, so it arrives by the same door a real file does.
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('content-disposition', 'attachment; filename="clip.mp4"');
      res.end(NOT_A_VIDEO);
      return;
    }
    if (url === '/page-attachment') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Generator</title><a id="get" href="/attachment" download="clip.mp4">Download</a>');
      return;
    }
    if (url === '/page-liar') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Generator</title><a id="get" href="/liar" download="clip.mp4">Download</a>');
      return;
    }
    if (url === '/page-blob') {
      // What a generator does: build the file in the page, hand it to a click,
      // and revoke the address in the same tick. Asking for it later is too
      // late, which is the failure this page exists for.
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><title>Generator</title><button id="get">Download</button><script>
        const bytes = new Uint8Array([${[...MP4].join(',')}]);
        document.getElementById('get').onclick = () => {
          const u = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
          const a = document.createElement('a');
          a.href = u; a.download = 'clip.mp4'; document.body.appendChild(a); a.click();
          URL.revokeObjectURL(u);
        };
      </script>`);
      return;
    }
    res.statusCode = 404;
    res.end();
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
  const ver = await (await fetch(`${chrome.endpoint}/json/version`)).json() as { webSocketDebuggerUrl: string };
  LOCAL_WS = ver.webSocketDebuggerUrl;
  browser = await chromium.connectOverCDP(chrome.endpoint);
  context = browser.contexts()[0] ?? await browser.newContext();
}, 60_000);

afterAll(async () => {
  await _closeCdpPool().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (chrome) { chrome.proc.kill('SIGKILL'); await chrome.exited; fs.rmSync(chrome.userDataDir, { recursive: true, force: true }); }
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => { _clearKeptDownloads(); });

/**
 * Drive the page's own download control and answer with what the browser
 * announced, the way the pool's arming does on a live session.
 *
 * The page's own control, not a fetch of a URL found on the page: a file
 * built in the renderer has no address anybody else can use, and a signed one
 * is spent by the time a second request arrives.
 */
async function clickToDownload(route: string): Promise<{ url: string; suggested: string }> {
  return withPage(VENDOR, SESSION, TENANT, async (page) => {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded' });
    const announced = new Promise<{ url: string; suggested: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no download was announced')), 10_000);
      const cdp = page.context().newCDPSession(page);
      void cdp.then(async (s) => {
        await s.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
        s.on('Browser.downloadWillBegin', (e: { url: string; suggestedFilename: string }) => {
          clearTimeout(t);
          resolve({ url: e.url, suggested: e.suggestedFilename });
        });
        await page.click('#get');
      }).catch(reject);
    });
    return announced;
  });
}

describe('a file the page itself hands over', () => {
  // The case every live run needed and none reached: a server file behind the
  // page's own download control.
  it('is taken while the browser is still holding it', async () => {
    const { url, suggested } = await clickToDownload('/page-attachment');
    expect(suggested).toBe('clip.mp4');
    await keepDownloadBytes(VENDOR, SESSION, TENANT, url);
    const file = await fetchFileForSession(TENANT, SESSION_ROW, { url });
    expect(file.bytes.byteLength).toBe(MP4.byteLength);
    expect(file.bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
    expect(file.contentType).toBe('video/mp4');
  }, 60_000);

  // A generator builds the file in the page and revokes the address in the
  // same tick. Asking for it later is too late.
  it('is taken from a blob the page has already let go of', async () => {
    const { url } = await clickToDownload('/page-blob');
    expect(url.startsWith('blob:')).toBe(true);
    await keepDownloadBytes(VENDOR, SESSION, TENANT, url);
    const file = await fetchFileForSession(TENANT, SESSION_ROW, { url });
    expect(file.bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
  }, 60_000);

  // Nothing downstream re-checks what it was handed, so a type taken from a
  // filename is a type nobody checked. An HTML error page called clip.mp4 is
  // what a rate-limited generator actually serves.
  it('is not called a video because it is called clip.mp4', async () => {
    const { url, suggested } = await clickToDownload('/page-liar');
    expect(suggested).toBe('clip.mp4');
    await keepDownloadBytes(VENDOR, SESSION, TENANT, url);
    const file = await fetchFileForSession(TENANT, SESSION_ROW, { url });
    expect(file.bytes.subarray(0, 9).toString('ascii')).toBe('<!doctype');
    // The claim under test: whatever this file is called, it must not reach
    // anybody labelled as a video.
    expect(file.contentType).not.toBe('video/mp4');
  }, 60_000);
});
