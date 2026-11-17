import Browserbase from '@browserbasehq/sdk';
import { armWebSessionReapFor } from '../../browser-sessions/reap-schedule';
import { chromium } from 'playwright-core';
import { navigateForFetch } from './browser-navigation';
import { storedCdpUrl } from '../../browser-sessions/cdp-endpoint';
import { withPage as withPooledPage } from '../../browser-sessions/cdp-page';
import { logger } from '../../infrastructure/logging';
import { ANY_CONNECTOR, type CredentialScope } from './credential-scope';
import { getWebToolCredential, type WebToolCredential } from './web-tool-secrets';
import { htmlToMarkdown } from './markdown';
import { BYOKVendorError, type VendorErrorCode } from './types';
import { buildByokErrorMessage, markConnectorErrored } from './byok-error-handler';
import { markCredentialCooling, markCredentialHealthy } from './credential-pool';
import type {
  WebFetchAdvancedClient, WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
  WebExtractRequest, InternalWebExtractResult,
} from './types';

const BB_TIMEOUT_MS = 60_000;
const USD_PER_BROWSER_HR = 0.10;

export class BrowserbaseError extends Error {
  constructor(message: string, public readonly statusCode?: number) { super(message); this.name = 'BrowserbaseError'; }
}

/** A router-bound request: the tenant, and which of its connectors may serve
 *  (credential-scope.ts). Required, so the compiler refuses a call that has
 *  not decided it. */
type WithTenant<T> = T & { tenantId: string; credentialScope: CredentialScope };

export class BrowserbaseClient implements WebFetchAdvancedClient {
  readonly vendor = 'browserbase' as const;

  supportsSessions(): boolean { return true; }

  /** Resolve the tenant's Browserbase credential (apiKey + projectId).
   *  No process-local caching — the resolver in web-tool-secrets has its
   *  own 60s TTL cache. */
  private async resolve(tenantId: string, scope: CredentialScope): Promise<WebToolCredential> {
    return getWebToolCredential(tenantId, 'browserbase', scope);
  }

  /** Public so the module-level thread-session factory below can reach it;
   *  that factory is part of this client's surface. */
  async sdkFor(tenantId: string, scope: CredentialScope): Promise<{ client: Browserbase; projectId: string; cred: WebToolCredential }> {
    return this.sdk(tenantId, scope);
  }

  private async sdk(tenantId: string, scope: CredentialScope): Promise<{ client: Browserbase; projectId: string; cred: WebToolCredential }> {
    const cred = await this.resolve(tenantId, scope);
    const projectId = cred.extra.projectId;
    if (!projectId) {
      throw new BrowserbaseError('browserbase projectId missing in connector credential', 400);
    }
    return { client: new Browserbase({ apiKey: cred.apiKey }), projectId, cred };
  }

  classifyVendorError(error: unknown): VendorErrorCode | null {
    if (!(error instanceof BrowserbaseError)) return null;
    const status = error.statusCode;
    if (status === undefined) return null;
    if (status === 401 || status === 403) return 'invalid_key';
    if (status === 402) return 'insufficient_funds';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'vendor_down';
    return null;
  }

  /** Wrap SDK + Playwright calls in BYOK classification so HTTP status codes
   *  thrown by @browserbasehq/sdk are translated into BYOKVendorError when
   *  classified as insufficient_funds / invalid_key. */
  private async withByokClassification<T>(
    tenantId: string,
    connectorId: string,
    op: () => Promise<T>,
  ): Promise<T> {
    try {
      const out = await op();
      // A key that works is a key that works: clear any cooldown it was under
      // rather than keeping it sidelined for the rest of a window it has
      // evidently left.
      markCredentialHealthy(connectorId);
      return out;
    } catch (err) {
      const bbErr = toBrowserbaseError(err);
      const classified = this.classifyVendorError(bbErr);
      // Browserbase goes through its SDK rather than a raw fetch, so there is
      // no Response to read limit headers off. The status is all we get — so
      // the cooldown falls back to the default window instead of the number the
      // vendor would otherwise have told us.
      if (classified === 'rate_limited') {
        markCredentialCooling({
          tenantId, vendor: 'browserbase', connectorId, reason: 'rate_limited',
        });
      }
      if (classified === 'insufficient_funds' || classified === 'invalid_key') {
        await markConnectorErrored(
          tenantId, 'browserbase', connectorId, classified, bbErr.message,
        );
        throw new BYOKVendorError(
          classified, 'browserbase', tenantId, connectorId,
          buildByokErrorMessage('browserbase', classified),
        );
      }
      throw err;
    }
  }

  async fetch(req: WithTenant<WebFetchAdvancedRequest>): Promise<InternalWebFetchAdvancedResult> {
    const { client: bb, projectId, cred } = await this.sdk(req.tenantId, req.credentialScope);
    return this.withByokClassification(req.tenantId, cred.connectorId, async () => {
      const startMs = Date.now();
      const session = await bb.sessions.create({
        projectId,
        browserSettings: { recordSession: false, logSession: false } as unknown as Record<string, unknown>,
      } as unknown as Parameters<typeof bb.sessions.create>[0]);
      let liveViewUrl: string | undefined;
      try {
        const debug = await (bb.sessions as unknown as { debug: (id: string) => Promise<{ debuggerFullscreenUrl?: string }> }).debug(session.id);
        liveViewUrl = debug.debuggerFullscreenUrl;
      } catch {
        // debug endpoint not available — leave live view unset
      }
      const browser = await chromium.connectOverCDP(session.connectUrl);
      let html: string, finalUrl: string;
      try {
        const ctx = browser.contexts()[0] ?? await browser.newContext();
        const page = ctx.pages()[0] ?? await ctx.newPage();
        await navigateForFetch(page, req.url, BB_TIMEOUT_MS);
        if (req.waitFor?.type === 'selector')    await page.waitForSelector(req.waitFor.value, { timeout: 10_000 });
        else if (req.waitFor?.type === 'networkidle') await page.waitForLoadState('networkidle', { timeout: 10_000 });
        else if (req.waitFor?.type === 'time')   await page.waitForTimeout(req.waitFor.ms);
        html = await page.content();
        finalUrl = page.url();
      } finally {
        await browser.close();
      }
      const elapsedMs = Date.now() - startMs;
      return {
        content: htmlToMarkdown(html),
        finalUrl,
        sessionId: req.sessionId,
        liveViewUrl,
        vendor: 'browserbase',
        costMicros: Math.round((elapsedMs / 3_600_000) * USD_PER_BROWSER_HR * 1_000_000),
        jsRendered: true,
      };
    });
  }

  async extract(req: WithTenant<WebExtractRequest>): Promise<InternalWebExtractResult> {
    const cred = await this.resolve(req.tenantId, req.credentialScope);
    const projectId = cred.extra.projectId;
    if (!projectId) throw new BrowserbaseError('browserbase projectId missing in connector credential', 400);
    return this.withByokClassification(req.tenantId, cred.connectorId, async () => {
      const stagehandMod = await import('@browserbasehq/stagehand');
      const { Stagehand } = stagehandMod as unknown as {
        Stagehand: new (opts: { env: string; apiKey: string; projectId: string }) => {
          init(): Promise<void>;
          close(): Promise<void>;
          page: { goto(u: string): Promise<unknown>; url(): string };
          extract(args: { instruction: string; schema: unknown }): Promise<unknown>;
        };
      };
      const stagehand = new Stagehand({ env: 'BROWSERBASE', apiKey: cred.apiKey, projectId });
      const startMs = Date.now();
      await stagehand.init();
      try {
        const page = stagehand.page;
        await page.goto(req.url);
        const data = await stagehand.extract({
          instruction: req.prompt ?? `Extract data matching this schema: ${JSON.stringify(req.schema)}`,
          schema: req.schema,
        });
        return {
          data,
          finalUrl: page.url(),
          vendor: 'browserbase',
          costMicros: Math.round(((Date.now() - startMs) / 3_600_000) * USD_PER_BROWSER_HR * 1_000_000),
          jsRendered: true,
        };
      } finally {
        await stagehand.close();
      }
    });
  }

  // ── Pane operations ─────────────────────────────────────────────────────
  //
  // Browserbase reports supportsSessions() true, and for a long time that was
  // only half true: it could hold a scrape session for fetch/extract but
  // implemented ONE of the ten operations the pane needs, so listing it as a
  // pane vendor would have handed a thread to a browser that accepted `goto`
  // and did nothing. The dispatch casts through `unknown`, so nothing would
  // have caught it at compile time either — it would have surfaced to a person
  // as a page that never moved.
  //
  // It is a real pane vendor now. Everything below is CDP over the session's
  // connectUrl, the same way Browser Use drives its own, because Browserbase
  // hands out a browser and a live view and nothing else. Anchor is the outlier
  // that exposes goto/screenshot as REST verbs; the other two are Playwright.

  /** Look up a live session's CDP endpoint.
   *
   *  Re-read per call rather than cached: connectUrl is only meaningful while
   *  the session is RUNNING, and a stale one fails in a way that looks like the
   *  page is broken rather than the session being gone. */
  private async cdpUrlFor(vendorSessionId: string, tenantId: string): Promise<string> {
    const { client: bb } = await this.sdk(tenantId, ANY_CONNECTOR);
    const session = await bb.sessions.retrieve(vendorSessionId);
    if (session.status !== 'RUNNING' || !session.connectUrl) {
      throw new BrowserbaseError(
        `browserbase session ${vendorSessionId} is ${session.status}`, 410,
      );
    }
    return session.connectUrl;
  }

  /** Run one operation against the session's page, over the ONE pooled
   *  connection every pane operation shares (browser-sessions/cdp-page.ts). */
  private async withPage<T>(
    vendorSessionId: string,
    tenantId: string,
    fn: (page: import('playwright-core').Page) => Promise<T>,
    opName = 'withPage',
  ): Promise<T> {
    return withPooledPage('browserbase', vendorSessionId, tenantId, fn, opName);
  }

  /** The endpoint the pooled connection and takeover capture attach to: our
   *  stored one first, the vendor's on a miss or when the caller asks for a
   *  fresh one because the stored one did not connect. */
  async cdpEndpointFor(vendorSessionId: string, tenantId: string, opts?: { fresh?: boolean }): Promise<string> {
    if (!opts?.fresh) {
      const stored = await storedCdpUrl(vendorSessionId);
      if (stored) return stored;
    }
    return this.cdpUrlFor(vendorSessionId, tenantId);
  }

  /** No-ops, and correctly so.
   *
   *  pauseAgent/resumeAgent exist to stop ANCHOR's in-session agent, which
   *  drives the browser independently of us. Browserbase has no in-session
   *  agent — our own loop is the only thing driving it — so the takeover_state
   *  row is the entire mechanism: it gates our agent at tool dispatch. There is
   *  nothing on the vendor side to pause, and throwing instead would break
   *  takeover for this vendor entirely. */
  async pauseAgent(_vendorSessionId: string, _tenantId: string): Promise<void> { /* no vendor-side agent */ }

  async resumeAgent(_vendorSessionId: string, _tenantId: string): Promise<void> { /* no vendor-side agent */ }

  async gotoUrl(vendorSessionId: string, tenantId: string, url: string): Promise<void> {
    await this.withPage(vendorSessionId, tenantId, (page) =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: BB_TIMEOUT_MS }).then(() => undefined), 'gotoUrl');
  }

  async getActivePage(vendorSessionId: string, tenantId: string): Promise<{ url: string; title: string }> {
    return this.withPage(vendorSessionId, tenantId, async (page) => ({
      url: page.url(),
      title: await page.title().catch(() => ''),
    }), 'getActivePage');
  }

  async fetchScreenshotPng(vendorSessionId: string, tenantId: string): Promise<Buffer> {
    return this.withPage(vendorSessionId, tenantId, (page) => page.screenshot({ type: 'png' }), 'fetchScreenshotPng');
  }

  /** Page text as markdown: the live DOM read over CDP, which is the same thing
   *  the person is looking at. */
  async fetchActivePageContent(vendorSessionId: string, tenantId: string): Promise<string> {
    const html = await this.withPage(vendorSessionId, tenantId, (page) => page.content(), 'fetchActivePageContent');
    return htmlToMarkdown(html);
  }

  /** Viewport screenshot, or the whole scrollable height when asked. The other
   *  options on this signature are Anchor's screenshot endpoint (scroll
   *  behaviour, explicit dimensions, quality, settle delay); Playwright takes a
   *  flag, and ignoring the rest returns a correct screenshot rather than
   *  refusing over a knob that does not apply. */
  async fetchToolsScreenshot(
    vendorSessionId: string,
    tenantId: string,
    opts?: { captureFullHeight?: boolean },
  ): Promise<Buffer> {
    return this.withPage(vendorSessionId, tenantId, (page) =>
      page.screenshot({ type: 'png', fullPage: !!opts?.captureFullHeight }), 'fetchToolsScreenshot');
  }

  /** Current page as a PDF. Chromium only renders PDF in headless mode and
   *  these sessions are headful so the person can watch, so this asks for the
   *  print stylesheet explicitly rather than silently returning a blank page. */
  async fetchActivePagePdf(vendorSessionId: string, tenantId: string): Promise<Buffer> {
    return this.withPage(vendorSessionId, tenantId, async (page) => {
      await page.emulateMedia({ media: 'print' });
      return page.pdf({ printBackground: true, format: 'A4' });
    }, 'fetchActivePagePdf');
  }

  /** Hand a multi-step instruction to an agent driving THIS session.
   *
   *  Stagehand over the session's own CDP url, exactly as the Browser Use
   *  client does it, and for the same reason: the work has to happen in the
   *  browser the person is watching. Browserbase's own Stagehand integration
   *  would provision a fresh session, so the pane would sit still while an
   *  invisible browser did the work — the defect that cost a customer three
   *  turns in one conversation on the other vendor. */
  async runAgentTask(
    vendorSessionId: string,
    tenantId: string,
    prompt: string,
    attribution?: import('../../browser-sessions/session-vendor-proxy').TaskAttribution,
  ): Promise<{ status: string; result?: unknown; data?: unknown }> {
    // The one entry for every vendor (browser-task.ts): the Jev loop over
    // this session's own CDP url, Stagehand as the tail.
    const { runBrowserTask } = await import('./browser-task');
    const cdpUrl = await this.cdpUrlFor(vendorSessionId, tenantId);
    return runBrowserTask({ vendor: 'browserbase', vendorSessionId, cdpUrl, prompt, tenantId, ...attribution });
  }

  /** Session stats for get_browser_session_stats. */
  async getSessionDetails(vendorSessionId: string, tenantId: string): Promise<{
    status: string; startedAt: string; finishedAt: string | null;
    costUsd: number; proxyMb: number;
  }> {
    const { client: bb } = await this.sdk(tenantId, ANY_CONNECTOR);
    const s = await bb.sessions.retrieve(vendorSessionId);
    return {
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.endedAt ?? null,
      costUsd: browserbaseSessionCostUsd(s),
      proxyMb: (s.proxyBytes ?? 0) / 1_048_576,
    };
  }

  // ── Profiles: the persistent logins behind "stay signed in" ──────────────
  //
  // Browserbase calls them CONTEXTS, and they are keyed by id with no name and
  // no list endpoint. That is why the local `web_profiles` row is authoritative
  // here rather than a convenience: it is the ONLY place the readable name and
  // the vendor's id are held together, and without it a context could be
  // created but never found again.

  /** Find-or-create by our own profile name.
   *
   *  A context the tenant already has is reused so a login survives; the
   *  vendor's id is whatever we recorded for that name. */
  async ensureProfile(tenantId: string, profileName: string, scope: CredentialScope): Promise<{ id: string; name: string }> {
    const { getPool } = await import('../../infrastructure/database');
    const { rows } = await getPool().query<{ vendor_profile_id: string }>(
      `SELECT vendor_profile_id FROM web_profiles
        WHERE tenant_id = $1 AND profile_name = $2 AND vendor = 'browserbase'
        LIMIT 1`,
      [tenantId, profileName],
    );
    const existing = rows[0]?.vendor_profile_id;
    if (existing) {
      // Confirm the vendor still has it. A context deleted at the vendor would
      // otherwise be attached to a new session, which Browserbase refuses, and
      // the person would lose the pane rather than just the stored login.
      const live = await this.contextExists(existing, tenantId, scope);
      if (live) return { id: existing, name: profileName };
    }
    const { client: bb, projectId } = await this.sdk(tenantId, scope);
    const created = await bb.contexts.create({ projectId });
    return { id: created.id, name: profileName };
  }

  private async contextExists(contextId: string, tenantId: string, scope: CredentialScope): Promise<boolean> {
    try {
      const { client: bb } = await this.sdk(tenantId, scope);
      await bb.contexts.retrieve(contextId);
      return true;
    } catch {
      return false;
    }
  }

  /** The contexts this tenant still actually has, used as the liveness
   *  cross-check behind web_session_list.
   *
   *  Browserbase exposes no way to LIST contexts, only to retrieve one by id,
   *  so the set is built from our own rows and each is verified. That is a
   *  different shape from the other two vendors and the same answer: a local
   *  row is only a reusable login if the vendor still holds the context.
   *
   *  cookieDomains stays null — Browserbase reports no cookie inventory. */
  async listProfiles(
    tenantId: string,
  ): Promise<Array<{ name: string; vendorProfileId: string; cookieDomains: string[] | null }>> {
    const { getPool } = await import('../../infrastructure/database');
    const { rows } = await getPool().query<{ profile_name: string; vendor_profile_id: string }>(
      `SELECT profile_name, vendor_profile_id FROM web_profiles
        WHERE tenant_id = $1 AND vendor = 'browserbase'`,
      [tenantId],
    );
    const out: Array<{ name: string; vendorProfileId: string; cookieDomains: string[] | null }> = [];
    for (const row of rows) {
      if (await this.contextExists(row.vendor_profile_id, tenantId, ANY_CONNECTOR)) {
        out.push({
          name: row.profile_name,
          vendorProfileId: row.vendor_profile_id,
          cookieDomains: null,
        });
      }
    }
    return out;
  }

  /** Delete a stored login at the vendor. Idempotent: a context already gone
   *  counts as forgotten, since surfacing a 404 would strand a local row the
   *  person cannot clear. */
  async deleteProfile(vendorProfileId: string, tenantId: string): Promise<void> {
    try {
      const { client: bb } = await this.sdk(tenantId, ANY_CONNECTOR);
      await bb.contexts.delete(vendorProfileId);
    } catch (err) {
      const status = toBrowserbaseError(err).statusCode;
      if (status === 404) return;
      throw err;
    }
  }

  /** Stop a pane session and record what it cost.
   *
   *  The metering is HERE for the same reason it is on the other two clients:
   *  a session is billed by the hour while it runs, so the total is not final
   *  until it ends, and every path that ends one comes through here.
   *
   *  Recording never blocks the close. A close that failed because billing was
   *  unavailable would leave a paid session running and holding a concurrency
   *  slot, which is strictly worse than an unrecorded one. */
  async closeSession(vendorSessionId: string, tenantId: string): Promise<void> {
    let settled: Awaited<ReturnType<typeof this.sdkSessionRetrieve>> | null = null;
    try {
      const { client: bb, projectId } = await this.sdk(tenantId, ANY_CONNECTOR);
      // Browserbase's session lifecycle is normally per-request (close on
      // browser.close()), but a pane session is created with keepAlive, so it
      // outlives every disconnect and has to be released explicitly or it
      // burns its whole timeout and holds a concurrency slot.
      await bb.sessions.update(vendorSessionId, {
        projectId,
        status: 'REQUEST_RELEASE',
      });
      settled = await this.sdkSessionRetrieve(vendorSessionId, tenantId).catch(() => null);
    } catch (e) {
      logger.warn('browserbase session close failed', { vendorSessionId, error: (e as Error).message });
    }

    try {
      const { recordSettledSessionCost } = await import('../../browser-sessions/session-cost');
      await recordSettledSessionCost({
        vendor: 'browserbase',
        tenantId,
        vendorSessionId,
        costUsd: settled ? browserbaseSessionCostUsd(settled) : null,
        // endedAt is set once the release lands. Absent means the session is
        // still winding down, and a figure read then is still climbing.
        settledAt: settled?.endedAt ? new Date(settled.endedAt) : null,
        // Browserbase is BYOK-only. Every session runs on the workspace's own
        // account, so the row is recorded for their analytics and debits no
        // Operating Units, the same treatment every strict vendor gets.
        funding: 'tenant_key',
        breakdown: {
          duration_sec: settled ? browserbaseDurationSec(settled) : 0,
          proxy_bytes: settled?.proxyBytes ?? 0,
        },
      });
    } catch (err) {
      logger.warn('browserbase session stopped but its cost could not be recorded', {
        vendorSessionId, error: (err as Error).message,
      });
    }
  }

  private async sdkSessionRetrieve(vendorSessionId: string, tenantId: string) {
    const { client: bb } = await this.sdk(tenantId, ANY_CONNECTOR);
    return bb.sessions.retrieve(vendorSessionId);
  }
}

/** How long a session actually ran, in seconds.
 *
 *  Browserbase reports timestamps rather than a duration, and a session that
 *  has not ended yet is measured to now — which is what makes the figure a
 *  RUNNING estimate rather than a bill, and why the settle path refuses to
 *  publish one without an endedAt. */
function browserbaseDurationSec(s: { startedAt: string; endedAt?: string }): number {
  const start = Date.parse(s.startedAt);
  if (!Number.isFinite(start)) return 0;
  const end = s.endedAt ? Date.parse(s.endedAt) : Date.now();
  return Math.max(0, (end - start) / 1000);
}

/** Browserbase bills browser time by the hour. It reports no money figure of
 *  its own on the session record, so this is time multiplied by the published
 *  rate — the same basis the fetch path has always used, kept in one function
 *  so the pane and the fetch chain cannot price the same vendor differently. */
function browserbaseSessionCostUsd(s: { startedAt: string; endedAt?: string }): number {
  return (browserbaseDurationSec(s) / 3600) * USD_PER_BROWSER_HR;
}

/** Normalize any thrown error into a BrowserbaseError so classifyVendorError
 *  can decide whether to wrap as BYOKVendorError. The SDK throws plain
 *  Errors with `status` / `statusCode` properties; Playwright throws its own
 *  shape. Best-effort extraction. */
function toBrowserbaseError(err: unknown): BrowserbaseError {
  if (err instanceof BrowserbaseError) return err;
  const e = err as { message?: string; status?: unknown; statusCode?: unknown };
  const status =
    (typeof e.statusCode === 'number' ? e.statusCode : undefined) ??
    (typeof e.status === 'number' ? e.status : undefined);
  return new BrowserbaseError(e?.message ?? String(err), status);
}

void logger;


/** Spawn a Browserbase session bound to a chat thread and record it.
 *
 *  Counterpart to createAnchorSessionForThread and
 *  createBrowserUseSessionForThread. Three things are load-bearing:
 *
 *  keepAlive. Browserbase ends a session when the last client disconnects, and
 *  every pane operation here is a connect-do-disconnect over CDP. Without it
 *  the browser would die on the first navigation and the person would watch the
 *  pane go blank mid-task. It needs the Hobby plan or above; a workspace whose
 *  plan cannot do it gets a clear refusal at spawn rather than a browser that
 *  quietly stops working.
 *
 *  A persisted CONTEXT, which is Browserbase's name for the cookie jar behind
 *  "stay signed in". Bound per (tenant, agent, owner) exactly as the other two
 *  vendors bind a profile, so a login the person completes in the pane survives
 *  across threads. An ownerless caller gets an ephemeral browser, because a
 *  shared persistent login store with no owner is nobody's to forget.
 *
 *  The live view. `debuggerFullscreenUrl` is the iframe the person watches, and
 *  a session without one cannot be a pane at all — so it is stopped rather than
 *  left running as a paid browser nobody can see.
 */
export async function createBrowserbaseSessionForThread(args: {
  tenantId: string;
  agentId: string;
  /** The thread this session serves, or null for a run-owned session. */
  threadId: string | null;
  /** The run this session serves, when a run rather than a thread opened it. */
  invocationId?: string | null;
  /** The person who opened this session, recorded on the row: they drive the
   *  pane and may take it over. Whose LOGINS the browser carries is the
   *  profile's business, below. */
  ownerAccountId?: string;
  /** Whose logins the browser carries. Decided by the proxy's one rule
   *  (browser-sessions/session-profile.ts); null is an ephemeral browser. */
  profile: import('../../browser-sessions/session-profile').SessionProfile | null;
  idleTimeoutMinutes?: number;
  /** Which of the workspace's Browserbase connectors may serve this session —
   *  the bound ones. Decided by the spawn from the team's binding; see
   *  credential-scope.ts. */
  credentialScope: CredentialScope;
}): Promise<import('../../browser-sessions/types').BrowserSession> {
  const { getPool } = await import('../../infrastructure/database');
  const { randomUUID } = await import('crypto');
  const client = new BrowserbaseClient();
  const callerSessionId = `ui:${randomUUID()}`;

  // The profile is handed in, named by the one rule every vendor shares.
  const ownerProfileName = args.profile?.name ?? null;
  const profile = ownerProfileName
    ? await client.ensureProfile(args.tenantId, ownerProfileName, args.credentialScope)
    : null;

  const { client: bb, projectId } = await client.sdkFor(args.tenantId, args.credentialScope);
  const timeoutSeconds = (args.idleTimeoutMinutes ?? 10) * 60;
  const session = await bb.sessions.create({
    projectId,
    keepAlive: true,
    timeout: timeoutSeconds,
    ...(profile
      ? { browserSettings: { context: { id: profile.id, persist: true } } }
      : {}),
  });

  let liveViewUrl: string | undefined;
  try {
    const debug = await bb.sessions.debug(session.id);
    liveViewUrl = debug.debuggerFullscreenUrl;
  } catch (err) {
    logger.warn('browserbase live view lookup failed', {
      sessionId: session.id, error: (err as Error).message,
    });
  }
  if (!session.connectUrl || !liveViewUrl) {
    // Stop it rather than leaking a paid, slot-holding session nobody can watch.
    await client.closeSession(session.id, args.tenantId).catch(() => undefined);
    throw new BrowserbaseError(
      'browserbase session created without a connect url or a live view', 502,
    );
  }

  const pool = getPool();
  const insertResult = await pool.query(
    `INSERT INTO web_sessions (
       tenant_id, agent_id, thread_id, invocation_id, owner_account_id, caller_session_id,
       vendor, vendor_session_id, vendor_metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, 'browserbase', $7, $8)
     RETURNING *`,
    [
      args.tenantId, args.agentId, args.threadId, args.invocationId ?? null,
      args.ownerAccountId ?? null, callerSessionId,
      session.id,
      // funding is recorded on the session rather than re-derived later. It is
      // always the workspace's own key here (Browserbase is BYOK-only), and
      // stating it keeps every pane row readable the same way.
      JSON.stringify({
        cdp_url: session.connectUrl,
        live_view_url: liveViewUrl,
        funding: 'tenant_key',
      }),
    ],
  );
  // The reaper is armed for the earliest open session (reap-schedule.ts).
  armWebSessionReapFor(insertResult.rows[0]);
  const row = insertResult.rows[0] as Record<string, unknown>;
  // Recorded AFTER the session create succeeds, so a failed spawn never leaves
  // an orphan profile row pointing at a context nobody can reach. profile_kind
  // 'pane' matches the other vendors: one browser per (tenant, agent, owner)
  // that may accumulate many site logins, as distinct from a deliberate
  // per-site 'saved' profile.
  if (args.profile && profile) {
    await pool.query(
      `INSERT INTO web_profiles (tenant_id, profile_name, vendor, vendor_profile_id, owner_account_id, agent_id, profile_kind)
       VALUES ($1, $2, 'browserbase', $3, $4, $5, $6)
       ON CONFLICT (tenant_id, profile_name)
       DO UPDATE SET vendor            = EXCLUDED.vendor,
                     vendor_profile_id = EXCLUDED.vendor_profile_id,
                     owner_account_id  = EXCLUDED.owner_account_id,
                     agent_id          = EXCLUDED.agent_id,
                     profile_kind      = EXCLUDED.profile_kind,
                     updated_at        = now()`,
      [args.tenantId, args.profile.name, profile.id, args.profile.ownerAccountId, args.agentId, args.profile.kind],
    );
  }
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    agentId: row.agent_id as string,
    threadId: (row.thread_id ?? null) as string | null,
    invocationId: (row.invocation_id ?? null) as string | null,
    vendor: row.vendor as string,
    vendorSessionId: row.vendor_session_id as string,
    liveViewUrl,
    createdAt: row.created_at as Date,
    lastUsedAt: (row.last_used_at ?? null) as Date | null,
    expiresAt: (row.expires_at ?? null) as Date | null,
    closedAt: null,
    closedReason: null,
    takeoverState: 'none',
    takenOverAt: null,
    ownerAccountId: (row.owner_account_id ?? null) as string | null,
    callerSessionId: (row.caller_session_id ?? null) as string | null,
    currentUrl: null,
    lastScreenshotObjectPath: null,
    lastScreenshotAt: null,
  };
}
