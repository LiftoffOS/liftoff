// What the loop can see when the thing it was asked to make is finished.
//
// A generator's whole job ends the same way: a <video> appears on the page and
// the file behind it has to reach the person. The reference implementation gets
// there two ways at once — it reads the video element's HTML for the source,
// and it clicks the native download control inside the player.
//
// The second of those is not available to us and never will be: Chromium
// renders player controls in a CLOSED user-agent shadow root, so page script
// cannot see them, and our observation is page script. So the source is the
// only handle we can have, and this suite is about whether the loop is given
// it. Every earlier failure looked like "the task ran out of time"; it may
// simply never have been able to see the finished file at all.

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

import { observe, finalObservation } from '../observe';
import { listPageMedia, filesBlock } from '../../../../browser-sessions/page-media';

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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finished-media-'));
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

// A generator's finished page: the prompt that made it, and the clip. Shaped
// after the real one — the player carries `controls`, and the source is an
// address on another origin, which is where these files actually live.
const FINISHED = `<!doctype html><html><head><title>Video generation</title></head><body>
  <p>Prompt: a hand waving slowly against a plain blue background</p>
  <p>Your video is ready.</p>
  <video id="clip" controls src="https://cdn.example.test/generated/abc123.mp4"></video>
  <button id="again">Generate again</button>
</body></html>`;

function startServer(): Promise<http.Server> {
  const srv = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(FINISHED);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

let chrome: Launched | null = null;
let server: http.Server;
let base = '';
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  server = await startServer();
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  chrome = await launchChromium();
  browser = await chromium.connectOverCDP(chrome.endpoint);
  context = browser.contexts()[0] ?? await browser.newContext();
  page = await context.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  if (chrome) { chrome.proc.kill('SIGKILL'); await chrome.exited; fs.rmSync(chrome.userDataDir, { recursive: true, force: true }); }
  await new Promise<void>((r) => server.close(() => r()));
});

describe('the finished file on a generator page', () => {
  // The control the reference clicks. Asserted as ABSENT on purpose: it lives
  // in a closed user-agent shadow root, so no amount of work on our snapshot
  // will surface it, and a plan that depends on clicking it is a plan that
  // cannot work here. This test exists so nobody proposes that route again.
  it('has a native download control our observation cannot reach, by construction', async () => {
    const reachable = await page.evaluate(() => {
      const v = document.getElementById('clip') as HTMLVideoElement | null;
      return { hasShadow: Boolean(v && (v as unknown as { shadowRoot: unknown }).shadowRoot) };
    });
    expect(reachable.hasShadow).toBe(false);
  });

  // The handle we CAN have. The loop's observation is what the model decides
  // from, so a source the observation does not carry is a file the model
  // cannot ask for, whatever else it does right.
  it('gives the loop the address of the file it just made', async () => {
    const state = await observe(page);
    const serialised = JSON.stringify(state);
    expect(serialised).toContain('https://cdn.example.test/generated/abc123.mp4');
  });

  // The words the model actually reads. Naming the file is the whole point:
  // this page said "Your video is ready" and offered a button marked
  // "Generate again", and that is what ten minutes of waiting was spent on.
  it('names the file in the words the model reads, and says it can be delivered', async () => {
    const view = finalObservation(await observe(page));
    expect(view.text).toContain('https://cdn.example.test/generated/abc123.mp4');
    expect(view.text).toContain('fetch one by its address');
  });

  // The assistants read the page by a different route — each vendor's own text
  // extraction — so they are told about the file by this one. Two readers of
  // one page must not be told different things about it.
  it('tells the assistants reader the same thing', async () => {
    const block = filesBlock(await listPageMedia(page));
    expect(block).toContain('https://cdn.example.test/generated/abc123.mp4');
    expect(block).toContain('video');
  });

  // What a generator that renders in the browser actually leaves behind: no
  // server address at all, only what the page built. `currentSrc` is the
  // address that resolves, and it is a blob — which is exactly the kind the
  // session now holds onto rather than racing.
  it('names a file the page built in the browser, which has no server address', async () => {
    const built = await context.newPage();
    await built.goto(base, { waitUntil: 'domcontentloaded' });
    await built.evaluate(() => {
      const v = (globalThis as unknown as { document: { getElementById(id: string): unknown } })
        .document.getElementById('clip') as { src: string };
      const g = globalThis as unknown as { Blob: new (p: unknown[], o: unknown) => unknown; URL: { createObjectURL(b: unknown): string } };
      v.src = g.URL.createObjectURL(new g.Blob([new Uint8Array([0, 0, 0, 24])], { type: 'video/mp4' }));
    });
    const files = await listPageMedia(built);
    expect(files.length).toBe(1);
    expect(files[0].src.startsWith('blob:')).toBe(true);
    await built.close();
  });
});
