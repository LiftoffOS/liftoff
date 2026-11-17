import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { Mutex } from 'async-mutex';
import { randomUUID } from 'crypto';
import { TabNotFoundError, TabBusyError } from '../shared/errors';
import { config } from '../config';
import { logger } from '../shared/logger';

const DEFAULT_CONTEXT_ID = 'default';
const LOCK_TIMEOUT_MS = 60_000;

interface PageEntry {
  page: Page;
  mutex: Mutex;
  queueDepth: number;
  consoleBuffer: Array<{ level: string; text: string; ts: number }>;
  capturedRequests: Array<{ requestId: string; url: string; method: string; status?: number; durationMs?: number; requestHeaders: Record<string, string>; responseHeaders?: Record<string, string>; requestBody?: string; responseBody?: string; failed?: { errorText: string }; startedAt: number }>;
  activeRoutes: Map<string, { urlPattern: string; handler: (route: import('playwright').Route) => Promise<void> }>;
}

interface ContextEntry {
  context: BrowserContext;
  pages: Map<string, PageEntry>;
}

function launchArgs(): string[] {
  // NOTE: --user-data-dir is intentionally omitted. Playwright's
  // chromium.launch() rejects it as a launch arg and instead requires
  // chromium.launchPersistentContext(userDataDir, ...). Browser state we
  // care about (cookies, localStorage) is captured per-context via
  // createNamedContext({ storageStatePath }), not via a persistent profile.
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--remote-debugging-port=9222',
    '--remote-debugging-address=127.0.0.1',
    '--proxy-server=http://127.0.0.1:8118',
    '--ignore-certificate-errors',
  ];
}

async function defaultContextOptions() {
  return {
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    permissions: [] as string[],
    ignoreHTTPSErrors: true,
    bypassCSP: false,
  };
}

export class BrowserContextRegistry {
  private browser: Browser | null = null;
  private contexts = new Map<string, ContextEntry>();
  private browserMutex = new Mutex();

  /**
   * Lazy-launch the Chromium singleton. Private — the raw Browser handle
   * never leaves the registry, so no caller can bypass the mutex / context
   * bookkeeping by invoking newContext()/close() on it directly. The only
   * paths that touch chromium primitives are this class's own methods.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.launch({
      headless: false,
      args: launchArgs(),
      env: { ...process.env, DISPLAY: ':99' } as Record<string, string>,
      timeout: 30_000,
    });
    this.browser.on('disconnected', () => {
      logger.warn({ msg: 'browser disconnected' });
      this.browser = null;
      this.contexts.clear();
    });
    return this.browser;
  }

  /**
   * Build the bookkeeping wrapper around a new Page. Wires the console /
   * request / response listeners that populate consoleBuffer and the HAR-like
   * capturedRequests ring buffer.
   */
  private buildPageEntry(page: Page): PageEntry {
    const entry: PageEntry = {
      page,
      mutex: new Mutex(),
      queueDepth: 0,
      consoleBuffer: [],
      capturedRequests: [],
      activeRoutes: new Map(),
    };
    page.on('console', msg => {
      entry.consoleBuffer.push({ level: msg.type(), text: msg.text(), ts: Date.now() });
      while (entry.consoleBuffer.length > 1000) entry.consoleBuffer.shift();
    });
    page.on('request', req => {
      entry.capturedRequests.push({
        requestId: `${req.url()}-${Date.now()}`,
        url: req.url(),
        method: req.method(),
        requestHeaders: req.headers(),
        startedAt: Date.now(),
      });
      while (entry.capturedRequests.length > 500) entry.capturedRequests.shift();
    });
    page.on('response', async res => {
      const match = entry.capturedRequests.find(c => c.url === res.url() && c.status === undefined);
      if (match) {
        match.status = res.status();
        match.responseHeaders = res.headers();
        match.durationMs = Date.now() - match.startedAt;
      }
    });
    page.on('requestfailed', req => {
      const match = entry.capturedRequests.find(c => c.url === req.url() && c.status === undefined);
      if (match) match.failed = { errorText: req.failure()?.errorText ?? 'unknown' };
    });
    return entry;
  }

  /**
   * Open a page in the default context (lazy-creating the context if missing).
   * The default context is the shared pool used by ordinary `browser_new_tab`
   * + `browser_navigate` flows — cookies + localStorage are shared across all
   * tabs in this context, which matches the agent-infra "browser singleton"
   * model. For isolated profiles use createNamedContext.
   *
   * Returns the new tab's id only. The raw Page handle is not exposed; all
   * subsequent operations on the tab must go through `withPageLock(tabId, fn)`
   * which enforces the per-tab mutex + queue cap.
   */
  async openPage(contextId = DEFAULT_CONTEXT_ID): Promise<{ tabId: string }> {
    return this.browserMutex.runExclusive(async () => {
      const browser = await this.ensureBrowser();
      let ctxEntry = this.contexts.get(contextId);
      if (!ctxEntry) {
        const context = await browser.newContext(await defaultContextOptions());
        ctxEntry = { context, pages: new Map() };
        this.contexts.set(contextId, ctxEntry);
      }
      const page = await ctxEntry.context.newPage();
      const tabId = randomUUID();
      const entry = this.buildPageEntry(page);
      ctxEntry.pages.set(tabId, entry);
      return { tabId };
    });
  }

  /**
   * Create an isolated context with custom Playwright options (recordVideo,
   * storageState, viewport, etc.) and open one page on it. The registry owns
   * the context lifecycle — it is the single place that calls
   * `browser.newContext(...)`. Callers reference the new tab via the returned
   * tabId and operate through `withPageLock`.
   *
   * Use cases (in-tree today):
   *   • browser/state.ts loadState({ storageState }) — replay cookies
   *   • browser/page-record.ts startRecording({ recordVideo, viewport })
   *
   * Throws if `contextId === 'default'` (reserved) or if a context with that
   * id is already registered.
   */
  async createNamedContext(
    contextId: string,
    options: BrowserContextOptions,
  ): Promise<{ tabId: string }> {
    if (contextId === DEFAULT_CONTEXT_ID) {
      throw new Error(`refused to create named context with reserved id "${DEFAULT_CONTEXT_ID}"`);
    }
    return this.browserMutex.runExclusive(async () => {
      if (this.contexts.has(contextId)) {
        throw new Error(`context already registered: ${contextId}`);
      }
      const browser = await this.ensureBrowser();
      const defaults = await defaultContextOptions();
      const context = await browser.newContext({ ...defaults, ...options });
      const page = await context.newPage();
      const tabId = randomUUID();
      const entry = this.buildPageEntry(page);
      this.contexts.set(contextId, { context, pages: new Map([[tabId, entry]]) });
      return { tabId };
    });
  }

  /**
   * Private internal locator — used inside the class for the public narrow
   * accessors below and by withPageLock to thread the entry into the
   * mutex-protected callback. Never exposed: callers can't reach Page,
   * consoleBuffer, capturedRequests, or activeRoutes except via the narrow
   * methods or under withPageLock.
   */
  private getEntry(tabId: string): PageEntry {
    for (const ctx of this.contexts.values()) {
      const entry = ctx.pages.get(tabId);
      if (entry) return entry;
    }
    throw new TabNotFoundError(tabId);
  }

  /**
   * Drain the per-tab console buffer. Returns a snapshot copy filtered by
   * timestamp; the underlying ring buffer is not mutated. The buffer is
   * populated by the page.on('console') listener wired in buildPageEntry,
   * which runs single-threaded on Node's event loop, so this snapshot is
   * race-free.
   */
  getConsoleMessages(tabId: string, since?: number): Array<{ level: string; text: string; ts: number }> {
    const entry = this.getEntry(tabId);
    return entry.consoleBuffer.filter(m => (since ? m.ts > since : true)).slice();
  }

  /**
   * Drain the per-tab captured request buffer (HAR-like). Returns a snapshot
   * filtered by start timestamp; never mutates the ring buffer.
   */
  getCapturedRequests(tabId: string, since?: number): Array<{
    requestId: string;
    url: string;
    method: string;
    status?: number;
    durationMs?: number;
    requestHeaders: Record<string, string>;
    responseHeaders?: Record<string, string>;
    requestBody?: string;
    responseBody?: string;
    failed?: { errorText: string };
    startedAt: number;
  }> {
    const entry = this.getEntry(tabId);
    return entry.capturedRequests.filter(c => (since ? c.startedAt > since : true)).slice();
  }

  /**
   * Navigate the tab in a freshly-created named context to `url`. Useful
   * when the caller wants to start the context-owning operation with a
   * specific URL (e.g. recording from a fixed page).
   */
  async navigateInTab(tabId: string, url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'load', timeoutMs = 30_000): Promise<void> {
    await this.withPageLock(tabId, async page => {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
    });
  }

  async withPageLock<T>(tabId: string, fn: (page: Page, entry: PageEntry) => Promise<T>): Promise<T> {
    const entry = this.getEntry(tabId);
    if (entry.queueDepth >= config.browserTabQueueMax) throw new TabBusyError();
    entry.queueDepth++;
    try {
      return await entry.mutex.runExclusive(() =>
        Promise.race([
          fn(entry.page, entry),
          new Promise<T>((_, reject) => setTimeout(() => reject(new Error('page_op_timeout')), LOCK_TIMEOUT_MS)),
        ]),
      );
    } finally {
      entry.queueDepth--;
    }
  }

  listTabs(): Array<{ tabId: string; url: string; title: string }> {
    const out: Array<{ tabId: string; url: string; title: string }> = [];
    for (const ctx of this.contexts.values()) {
      for (const [tabId, entry] of ctx.pages) {
        out.push({ tabId, url: entry.page.url(), title: '' });
      }
    }
    return out;
  }

  async closeTab(tabId: string): Promise<void> {
    return this.browserMutex.runExclusive(async () => {
      for (const ctx of this.contexts.values()) {
        const entry = ctx.pages.get(tabId);
        if (entry) {
          await entry.page.close({ runBeforeUnload: false }).catch(() => undefined);
          ctx.pages.delete(tabId);
          return;
        }
      }
      throw new TabNotFoundError(tabId);
    });
  }

  async closeAll(): Promise<void> {
    if (!this.browser) return;
    try {
      await this.browser.close();
    } catch {
      // ignore
    }
    this.browser = null;
    this.contexts.clear();
  }

  /**
   * Close a non-default context — typically one created via
   * `createNamedContext` (state loader, recording session). Idempotent;
   * unknown contextId is a no-op. The default context is protected because
   * dropping it would orphan every standard tab the agent has open.
   */
  async closeContext(contextId: string): Promise<void> {
    if (contextId === DEFAULT_CONTEXT_ID) {
      throw new Error('refused to close default context — use closeTab for tabs in the default context');
    }
    return this.browserMutex.runExclusive(async () => {
      const entry = this.contexts.get(contextId);
      if (!entry) return;
      // Close all pages first to drop any lingering route handlers + listeners.
      for (const pageEntry of entry.pages.values()) {
        await pageEntry.page.close({ runBeforeUnload: false }).catch(() => undefined);
      }
      try {
        await entry.context.close();
      } catch {
        // already closed
      }
      this.contexts.delete(contextId);
    });
  }

  /**
   * Chromium's CDP endpoint. The launch args pin `--remote-debugging-port=9222`
   * + `--remote-debugging-address=127.0.0.1`, so the CDP WebSocket is reachable
   * at `ws://127.0.0.1:9222/devtools/browser/<id>`. cdp-info.ts queries
   * `http://127.0.0.1:9222/json/version` for the canonical `webSocketDebuggerUrl`
   * — Playwright's Browser type does not expose wsEndpoint() for
   * locally-launched browsers (it's a BrowserServer-only API).
   */
  cdpEndpoint(): string {
    if (!this.browser) return '';
    return 'ws://127.0.0.1:9222';
  }

  /**
   * Health probe — does NOT hand out the raw Browser handle. Returns true
   * before lazy-launch (the browser hasn't been needed yet and starting it
   * eagerly on a health check would be wasteful) and true when launched +
   * connected; false only when the launch is broken (segfault, OOM,
   * disconnected).
   */
  isHealthy(): boolean {
    if (!this.browser) return true;
    return this.browser.isConnected();
  }
}

export const browserContextRegistry = new BrowserContextRegistry();

export async function isBrowserHealthy(): Promise<boolean> {
  try {
    return browserContextRegistry.isHealthy();
  } catch {
    return false;
  }
}
