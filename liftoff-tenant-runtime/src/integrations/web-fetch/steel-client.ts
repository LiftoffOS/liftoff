// Steel, as a web-tools vendor: the platform's agent browser, and a browser a
// workspace may bring on its own key.
//
// Steel hands out a browser (a CDP websocket), a live view a person can watch
// and take over (`debugUrl?interactive=true`), and profiles (a snapshot of the
// browser's user data directory, so a login survives across sessions). It
// bills per session-minute with auto top-up on the account, which is why it
// takes the platform slot from Browser Use, whose pay-as-you-go credit can run
// out with nothing to reload it. Browser Use stays as the fallback vendor and
// keeps its own client; nothing here replaces it.
//
// Two lanes through ONE resolver, exactly as browser-use-client.ts does it:
// a workspace's own Steel connector (funding 'tenant_key': the workspace pays
// Steel directly, the cost row debits no Operating Units) wins; a workspace
// that connected nothing gets the platform key (funding 'platform': Liftoff
// paid, the row falls through to the customer-chargeable path). A COOLING or
// errored tenant key is deliberately NOT failed over to the platform key —
// that would hide the workspace's own account problem and start charging
// them for a browser they are already paying for.
//
// Everything below is Playwright over the session's CDP url, the way the
// Browserbase client drives its pane: one pooled connection per session
// (browser-sessions/cdp-page.ts), endpoint from our row with a vendor
// re-read as the fallback, and a close of our client never releases the
// session (Steel sessions live until released or timed out). The one agent
// driving it is our own Stagehand loop (`runStagehandTask`), so pauseAgent /
// resumeAgent are no-ops and the takeover_state row is the whole mechanism.
//
// Verified against the live API: `GET /v1/sessions?limit=1` answers
// 200 on a valid key and 401 on an invalid one; `POST /v1/sessions` takes
// `timeout` and `inactivityTimeout` in MILLISECONDS; the Session object carries
// `websocketUrl`, `debugUrl`, `sessionViewerUrl`, `status` (live | released |
// failed), `duration` (ms), `creditsUsed` and `proxyBytesUsed`. The Launch plan
// caps a session at 15 minutes; a longer timeout is refused, so the pane asks
// for at most that.

import { chromium } from 'playwright-core';
import { armWebSessionReapFor } from '../../browser-sessions/reap-schedule';
import { storedCdpUrl } from '../../browser-sessions/cdp-endpoint';
import { PANE_DIMENSIONS, restorePaneViewport, withPage as withPooledPage } from '../../browser-sessions/cdp-page';
import { navigateForFetch } from './browser-navigation';
import { logger } from '../../infrastructure/logging';
import { ANY_CONNECTOR, type CredentialScope } from './credential-scope';
import {
  getWebToolCredential, getWebToolSecret, VendorNotConnected,
  type WebToolCredential,
} from './web-tool-secrets';
import { htmlToMarkdown } from './markdown';
import { BYOKVendorError, type VendorErrorCode, type WebToolFunding } from './types';
import { buildByokErrorMessage, markConnectorErrored } from './byok-error-handler';
import { markCredentialCooling, markCredentialHealthy } from './credential-pool';
import { PlatformBrowserUnavailable } from './browser-use-client';
import type {
  WebFetchAdvancedClient, WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
} from './types';

const STEEL_API_BASE = 'https://api.steel.dev/v1';
/** A fetch's whole budget: create, navigate, read, release. */
const FETCH_TIMEOUT_MS = 60_000;
/** A fetch session's own timeout at the vendor, so an orphan cannot outlive
 *  the call by much. Milliseconds, as the API takes them. */
const FETCH_SESSION_TIMEOUT_MS = 5 * 60_000;
/** The pane's default window and the Launch plan's ceiling, in minutes. */
const PANE_SESSION_MINUTES = 10;
const PLAN_MAX_SESSION_MINUTES = 15;
/** A pane nobody has touched for this long is released by the vendor. */
const PANE_INACTIVITY_MS = 5 * 60_000;
/** Browser time on the Launch plan, per hour; proxy egress per GiB. Steel's
 *  own `creditsUsed` is not documented in dollars, so the rate card is the
 *  figure of record and the credits ride along in the breakdown. */
const USD_PER_BROWSER_HR = 0.10;
const USD_PER_PROXY_GIB = 10;
export class SteelError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly body?: unknown) {
    super(message);
    this.name = 'SteelError';
  }
}

/** A router-bound request: the tenant, and which of its connectors may serve
 *  (credential-scope.ts). Required, so the compiler refuses a call that has
 *  not decided it. */
type WithTenant<T> = T & { tenantId: string; credentialScope: CredentialScope };

/** A Steel credential plus whose account it is. Same shape and same reason as
 *  browser-use-client's ResolvedCredential: `connectorId` null IS the funding
 *  signal, and widening WebToolCredential would blunt the compiler for the
 *  vendors where the id is always present. */
export interface ResolvedSteelCredential extends Omit<WebToolCredential, 'connectorId'> {
  connectorId: string | null;
}

export function steelFundingOf(cred: ResolvedSteelCredential): WebToolFunding {
  return cred.connectorId === null ? 'platform' : 'tenant_key';
}

/** The subset of Steel's Session object this module reads. */
export interface SteelSession {
  id: string;
  status: 'live' | 'released' | 'failed' | string;
  websocketUrl?: string;
  debugUrl?: string;
  sessionViewerUrl?: string;
  /** Milliseconds. */
  duration?: number;
  creditsUsed?: number;
  proxyBytesUsed?: number;
  timeout?: number;
  profileId?: string;
  releaseReason?: string | null;
  createdAt?: string;
}

/** The vendor's settled figure for a session, in USD, from its own duration and
 *  proxy egress at the plan's rates. Null when the session could not be read. */
export function steelSessionCostUsd(session: SteelSession | null): number | null {
  if (!session) return null;
  const hours = (session.duration ?? 0) / 3_600_000;
  const proxyGib = (session.proxyBytesUsed ?? 0) / 1_073_741_824;
  return hours * USD_PER_BROWSER_HR + proxyGib * USD_PER_PROXY_GIB;
}

/** The live view the pane embeds: interactive so the person can take over the
 *  moment they click into it, without the vendor's own URL bar and controls,
 *  which the pane draws for itself, and without the player's own interaction
 *  gate. With `interactive=true` alone the player starts in a "prompt" state
 *  and shows "Click to interact / View-only mode active" on hover until the
 *  person clicks (read out of the player's script:
 *  `interactionGateState = interactive && !hideInteractionDialog ? "prompt" :
 *  "enabled"`). The pane carries its own take-control flow, and Browser Use's
 *  live view has no gate, so Steel's is hidden to keep the two panes alike. */
export function steelLiveViewUrl(debugUrl: string): string {
  const sep = debugUrl.includes('?') ? '&' : '?';
  return `${debugUrl}${sep}interactive=true&showControls=false&hideInteractionDialog=true`;
}

export class SteelClient implements WebFetchAdvancedClient {
  readonly vendor = 'steel' as const;

  supportsSessions(): boolean { return true; }

  /** The ONE resolver: the workspace's own connector within `scope`, else the
   *  platform key. NO_WORKSPACE_CONNECTOR (a workspace Steel the team is not
   *  bound to) therefore lands on the platform key, never on that account. */
  async resolveCredential(tenantId: string, scope: CredentialScope): Promise<ResolvedSteelCredential> {
    try {
      const cred = await getWebToolCredential(tenantId, 'steel', scope);
      return { ...cred, connectorId: cred.connectorId };
    } catch (err) {
      if (!(err instanceof VendorNotConnected)) throw err;
      return {
        apiKey: await getWebToolSecret('steel-api-key'),
        connectorId: null,
        extra: {},
      };
    }
  }

  classifyVendorError(error: unknown): VendorErrorCode | null {
    if (!(error instanceof SteelError)) return null;
    const status = error.statusCode;
    if (status === 401 || status === 403) return 'invalid_key';
    // Steel auto-tops-up, so a 402 is a card that failed rather than a credit
    // that ran out; the remedy is the same: the account owner's.
    if (status === 402) return 'insufficient_funds';
    // The plan's concurrent-session ceiling (10 on Launch). Clears when a
    // sibling session ends, not after a window, so cool the credential and
    // retry rather than fail the vendor.
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'vendor_down';
    return null;
  }

  /** One request against the API, with the vendor's error envelope carried on
   *  the thrown error. Public so the thread-session factory can reach it. */
  async call<T>(
    path: string,
    apiKey: string,
    init: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown } = {},
  ): Promise<T> {
    const resp = await fetch(`${STEEL_API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'steel-api-key': apiKey,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text().catch(() => '');
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!resp.ok) {
      const message = typeof parsed === 'object' && parsed && 'message' in parsed
        ? String((parsed as { message: unknown }).message)
        : text.slice(0, 200);
      throw new SteelError(`steel ${init.method ?? 'GET'} ${path}: HTTP ${resp.status}${message ? ` ${message}` : ''}`, resp.status, parsed);
    }
    return parsed as T;
  }

  /** Classify a failure against the credential that made the call. A tenant
   *  key is cooled or flipped to error and the person is told; a platform-key
   *  failure has no connector to flip and no account of theirs to top up, so it
   *  is logged for operators and surfaced as the platform's own outage. Public
   *  so the thread-session factory runs its create through the same rule. */
  async withByokClassification<T>(
    tenantId: string,
    cred: ResolvedSteelCredential,
    op: () => Promise<T>,
  ): Promise<T> {
    const connectorId = cred.connectorId;
    try {
      const out = await op();
      if (connectorId !== null) markCredentialHealthy(connectorId);
      return out;
    } catch (err) {
      const classified = this.classifyVendorError(err);
      if (connectorId === null) {
        if (!classified) throw err;
        logger.error({
          tenantId, vendor: 'steel', classified,
          err: (err as Error).message,
          event: 'steel_platform_key_failed',
        }, 'the PLATFORM Steel key was rejected; no tenant connector is at fault');
        const retryable = classified === 'rate_limited' || classified === 'vendor_down';
        throw new PlatformBrowserUnavailable(
          classified,
          retryable,
          retryable
            ? 'The browser is busy right now. Try again in a moment.'
            : 'The browser is unavailable right now. This is a problem on the Liftoff side, '
              + 'not with your workspace, and the team has been alerted.',
        );
      }
      if (classified === 'rate_limited') {
        markCredentialCooling({ tenantId, vendor: 'steel', connectorId, reason: 'rate_limited' });
      }
      if (classified === 'insufficient_funds' || classified === 'invalid_key') {
        await markConnectorErrored(tenantId, 'steel', connectorId, classified, (err as Error).message);
        throw new BYOKVendorError(
          classified, 'steel', tenantId, connectorId,
          buildByokErrorMessage('steel', classified),
        );
      }
      throw err;
    }
  }

  // ── Headless fetch ───────────────────────────────────────────────────────

  async fetch(req: WithTenant<WebFetchAdvancedRequest>): Promise<InternalWebFetchAdvancedResult> {
    const cred = await this.resolveCredential(req.tenantId, req.credentialScope);
    return this.withByokClassification(req.tenantId, cred, async () => {
      const startMs = Date.now();
      const session = await this.call<SteelSession>('/sessions', cred.apiKey, {
        method: 'POST',
        body: { timeout: FETCH_SESSION_TIMEOUT_MS, dimensions: PANE_DIMENSIONS },
      });
      if (!session.websocketUrl) {
        await this.release(session.id, cred.apiKey);
        throw new SteelError('steel session created without a websocketUrl', 502, session);
      }
      let html: string, finalUrl: string;
      let settled: SteelSession | null = null;
      try {
        const browser = await chromium.connectOverCDP(session.websocketUrl);
        try {
          const ctx = browser.contexts()[0] ?? await browser.newContext();
          const page = ctx.pages()[0] ?? await ctx.newPage();
          await navigateForFetch(page, req.url, FETCH_TIMEOUT_MS);
          if (req.waitFor?.type === 'selector')         await page.waitForSelector(req.waitFor.value, { timeout: 10_000 });
          else if (req.waitFor?.type === 'networkidle') await page.waitForLoadState('networkidle', { timeout: 10_000 });
          else if (req.waitFor?.type === 'time')        await page.waitForTimeout(req.waitFor.ms);
          html = await page.content();
          finalUrl = page.url();
        } finally {
          await browser.close();
        }
      } finally {
        // Always: a session left live bills until its timeout and holds one of
        // the plan's concurrency slots.
        settled = await this.release(session.id, cred.apiKey);
      }
      const cost = steelSessionCostUsd(settled)
        ?? ((Date.now() - startMs) / 3_600_000) * USD_PER_BROWSER_HR;
      return {
        content: htmlToMarkdown(html),
        finalUrl,
        sessionId: req.sessionId,
        liveViewUrl: session.debugUrl ? steelLiveViewUrl(session.debugUrl) : undefined,
        vendor: 'steel',
        costMicros: Math.round(cost * 1_000_000),
        jsRendered: true,
        funding: steelFundingOf(cred),
      };
    });
  }

  /** Release a session and return its settled record. Never throws: a failed
   *  release must not mask the caller's real error, and the session expires on
   *  its own timeout regardless. The usual cause of a failed release is that
   *  something already released it, so the record is re-read before giving up.
   *
   *  A session ends at Steel in one of three ways, and all three are a release:
   *  this call, the inactivity timeout, and the hard timeout (the vendor's
   *  session-lifecycle documentation, read 2026-09-22). A profile the session
   *  runs with is snapshotted on the release, so a session nobody released
   *  keeps its logins too, later rather than now. Releasing here is what makes
   *  the snapshot immediate, which is why the close path awaits it before
   *  anything opens the next session on that profile. */
  async release(sessionId: string, apiKey: string): Promise<SteelSession | null> {
    try {
      await this.call<{ success: boolean }>(`/sessions/${encodeURIComponent(sessionId)}/release`, apiKey, { method: 'POST' });
    } catch (err) {
      logger.warn(
        { vendor_session_id: sessionId, err: (err as Error).message },
        'steel session release failed; it will expire on its own timeout',
      );
    }
    return this.call<SteelSession>(`/sessions/${encodeURIComponent(sessionId)}`, apiKey).catch(() => null);
  }

  // ── Pane operations ──────────────────────────────────────────────────────

  /** The session's CDP endpoint from the vendor, for when our stored one has
   *  gone stale. Only a live session has one worth connecting to. */
  private async cdpUrlFor(vendorSessionId: string, tenantId: string): Promise<string> {
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    const session = await this.call<SteelSession>(`/sessions/${encodeURIComponent(vendorSessionId)}`, cred.apiKey);
    if (session.status !== 'live' || !session.websocketUrl) {
      throw new SteelError(`steel session ${vendorSessionId} is ${session.status}`, 410, session);
    }
    return session.websocketUrl;
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

  /** Run one operation against the session's page, over the ONE pooled
   *  connection every pane operation shares (browser-sessions/cdp-page.ts). */
  private async withPage<T>(
    vendorSessionId: string,
    tenantId: string,
    fn: (page: import('playwright-core').Page) => Promise<T>,
    opName = 'withPage',
  ): Promise<T> {
    return withPooledPage('steel', vendorSessionId, tenantId, fn, opName);
  }

  /** No vendor-side agent to pause: our own loop is the only driver, and the
   *  takeover_state row gates it at tool dispatch. */
  async pauseAgent(_vendorSessionId: string, _tenantId: string): Promise<void> { /* no vendor-side agent */ }

  async resumeAgent(_vendorSessionId: string, _tenantId: string): Promise<void> { /* no vendor-side agent */ }

  async gotoUrl(vendorSessionId: string, tenantId: string, url: string): Promise<void> {
    await this.withPage(vendorSessionId, tenantId, (page) =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT_MS }).then(() => undefined), 'gotoUrl');
  }

  async getActivePage(vendorSessionId: string, tenantId: string): Promise<{ url: string; title: string }> {
    return this.withPage(vendorSessionId, tenantId, async (page) => ({
      url: page.url(),
      title: await page.title(),
    }), 'getActivePage');
  }

  async fetchScreenshotPng(vendorSessionId: string, tenantId: string): Promise<Buffer> {
    return this.withPage(vendorSessionId, tenantId, async (page) => {
      await restorePaneViewport(page, vendorSessionId);
      return page.screenshot({ type: 'png' });
    }, 'fetchScreenshotPng');
  }

  async fetchActivePageContent(vendorSessionId: string, tenantId: string): Promise<string> {
    const html = await this.withPage(vendorSessionId, tenantId, (page) => page.content(), 'fetchActivePageContent');
    return htmlToMarkdown(html);
  }

  async fetchToolsScreenshot(
    vendorSessionId: string,
    tenantId: string,
    opts?: { captureFullHeight?: boolean; scrollAllContent?: boolean; width?: number; height?: number; imageQuality?: number; waitMs?: number },
  ): Promise<Buffer> {
    return this.withPage(vendorSessionId, tenantId, async (page) => {
      if (opts?.width && opts?.height) await page.setViewportSize({ width: opts.width, height: opts.height });
      if (opts?.waitMs) await page.waitForTimeout(opts.waitMs);
      return page.screenshot({
        type: opts?.imageQuality ? 'jpeg' : 'png',
        ...(opts?.imageQuality ? { quality: opts.imageQuality } : {}),
        fullPage: !!(opts?.captureFullHeight || opts?.scrollAllContent),
      });
    }, 'fetchToolsScreenshot');
  }

  /** Chromium renders PDF in headless mode only, and a pane session is headful
   *  so the person can watch; ask for the print stylesheet explicitly rather
   *  than return a blank page. */
  async fetchActivePagePdf(vendorSessionId: string, tenantId: string): Promise<Buffer> {
    return this.withPage(vendorSessionId, tenantId, async (page) => {
      await page.emulateMedia({ media: 'print' });
      return page.pdf({ printBackground: true, format: 'A4' });
    }, 'fetchActivePagePdf');
  }

  /** Hand a multi-step instruction to an agent driving THIS session: Stagehand
   *  over the session's own CDP url, so the work happens in the browser the
   *  person is watching. */
  async runAgentTask(
    vendorSessionId: string,
    tenantId: string,
    prompt: string,
    attribution?: import('../../browser-sessions/session-vendor-proxy').TaskAttribution,
  ): Promise<{ status: string; result?: unknown; data?: unknown }> {
    // The one entry for every vendor (browser-task.ts): the Jev loop over
    // this session's own CDP url, Stagehand as the tail.
    const { runBrowserTask } = await import('./browser-task');
    const cdpUrl = (await storedCdpUrl(vendorSessionId)) ?? await this.cdpUrlFor(vendorSessionId, tenantId);
    return runBrowserTask({ vendor: 'steel', vendorSessionId, cdpUrl, prompt, tenantId, ...attribution });
  }

  /** Session stats for get_browser_session_stats. */
  async getSessionDetails(vendorSessionId: string, tenantId: string): Promise<{
    status: string; startedAt: string; finishedAt: string | null;
    costUsd: number; proxyMb: number;
  }> {
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    const s = await this.call<SteelSession>(`/sessions/${encodeURIComponent(vendorSessionId)}`, cred.apiKey);
    const startedAt = s.createdAt ?? new Date(0).toISOString();
    const finishedAt = s.status === 'released' || s.status === 'failed'
      ? new Date(new Date(startedAt).getTime() + (s.duration ?? 0)).toISOString()
      : null;
    return {
      status: s.status,
      startedAt,
      finishedAt,
      costUsd: steelSessionCostUsd(s) ?? 0,
      proxyMb: (s.proxyBytesUsed ?? 0) / 1_048_576,
    };
  }

  /** Release the session and record what it cost, on the funding that opened
   *  it. Recording never blocks the close: a paid session left running because
   *  billing was unavailable is strictly worse than an unrecorded one. */
  async closeSession(vendorSessionId: string, tenantId: string): Promise<void> {
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    const settled = await this.release(vendorSessionId, cred.apiKey);
    try {
      const { recordSettledSessionCost } = await import('../../browser-sessions/session-cost');
      await recordSettledSessionCost({
        vendor: 'steel',
        tenantId,
        vendorSessionId,
        costUsd: steelSessionCostUsd(settled),
        settledAt: settled && settled.status !== 'live'
          ? new Date(new Date(settled.createdAt ?? Date.now()).getTime() + (settled.duration ?? 0))
          : null,
        funding: steelFundingOf(cred),
        breakdown: {
          duration_sec: Math.round((settled?.duration ?? 0) / 1000),
          proxy_bytes: settled?.proxyBytesUsed ?? 0,
          credits_used: settled?.creditsUsed ?? 0,
          release_reason: settled?.releaseReason ?? null,
        },
      });
    } catch (err) {
      logger.warn(
        { vendor_session_id: vendorSessionId, err: (err as Error).message },
        'steel session released but its cost could not be recorded',
      );
    }
  }

  /** The vendor profile id we recorded for this local profile name, if any. */
  async storedProfileId(tenantId: string, profileName: string): Promise<string | null> {
    const { getPool } = await import('../../infrastructure/database');
    const { rows } = await getPool().query<{ vendor_profile_id: string | null }>(
      `SELECT vendor_profile_id FROM web_profiles
        WHERE tenant_id = $1 AND profile_name = $2 AND vendor = 'steel'
        LIMIT 1`,
      [tenantId, profileName],
    );
    return rows[0]?.vendor_profile_id ?? null;
  }

  /** The vendor profile behind a local profile name, or null for a name that
   *  has none yet.
   *
   *  Steel profiles have no name, and `POST /v1/profiles` is an UPLOAD of an
   *  existing browser archive (multipart, verified live: a JSON
   *  body answers 400), not a way to mint an empty one. A profile is minted by
   *  a session created with `persistProfile: true` and no `profileId`; the
   *  session carries the new id, and every later session binds it. So the
   *  deterministic local name resolves through OUR row, and a name with no
   *  row tells the factory to let the session mint one. */
  async ensureProfile(tenantId: string, profileName: string): Promise<{ id: string; name: string } | null> {
    const local = await this.storedProfileId(tenantId, profileName);
    return local ? { id: local, name: profileName } : null;
  }

  /** Profiles the vendor still holds, for the liveness cross-check behind
   *  web_session_list. Steel reports ids and status, no name and no cookie
   *  domains, so the id stands in for the name. On the platform key this is
   *  every workspace's profiles; the caller matches them to its own rows. */
  async listProfiles(tenantId: string): Promise<Array<{ name: string; vendorProfileId: string; cookieDomains: string[] | null }>> {
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    const res = await this.call<{ profiles?: Array<{ id: string; status?: string }> }>('/profiles', cred.apiKey);
    return (res.profiles ?? [])
      .filter((p) => p.status !== 'FAILED')
      .map((p) => ({ name: p.id, vendorProfileId: p.id, cookieDomains: null }));
  }

  /** Delete by vendor id. Idempotent: a profile already gone is a success.
   *  Tries the PLATFORM key too when the workspace's own key does not hold the
   *  profile: a workspace that browsed on our key before connecting its own
   *  has logins on both accounts, and "forget this login" must reach both. */
  async deleteProfile(vendorProfileId: string, tenantId: string): Promise<void> {
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    if (await this.tryDeleteProfile(vendorProfileId, cred.apiKey)) return;
    if (cred.connectorId === null) return;
    const platformKey = await getWebToolSecret('steel-api-key').catch(() => null);
    if (!platformKey) return;
    if (await this.tryDeleteProfile(vendorProfileId, platformKey)) {
      logger.info(
        { tenantId, vendorProfileId, event: 'steel_platform_profile_reclaimed' },
        'forgot a login left on the platform account from before this workspace connected its own key',
      );
    }
  }

  /** True when the profile was deleted, false when the account does not have
   *  it. Anything else throws: a 500 is not evidence that a login is gone. */
  private async tryDeleteProfile(vendorProfileId: string, apiKey: string): Promise<boolean> {
    try {
      await this.call<unknown>(`/profiles/${encodeURIComponent(vendorProfileId)}`, apiKey, { method: 'DELETE' });
      return true;
    } catch (err) {
      if (err instanceof SteelError && err.statusCode === 404) return false;
      throw err;
    }
  }
}

export const steelClient = new SteelClient();

/** Spawn a Steel session bound to a thread (or a run) and record it.
 *
 *  Counterpart to createBrowserUseSessionForThread. Funding comes through the
 *  ONE resolver so a pane is funded by the same rule a tool call is. Logins
 *  ride on a Steel profile bound per the proxy's one rule: the profile name
 *  resolves to a Steel profile id through our web_profiles row, a name with no
 *  row has the session mint one, every session with a name runs with
 *  `persistProfile: true`, and what it accumulates is saved back on release.
 *  An ownerless caller gets an ephemeral browser.
 *
 *  A session that comes back without a CDP url or a live view is released on
 *  the spot rather than left running as a paid browser nobody can drive or
 *  watch, and its window is settled against the caller's attribution, because
 *  this is the one path that never writes a web_sessions row. */
export async function createSteelSessionForThread(args: {
  tenantId: string;
  agentId: string;
  threadId: string | null;
  invocationId?: string | null;
  ownerAccountId?: string;
  profile: import('../../browser-sessions/session-profile').SessionProfile | null;
  idleTimeoutMinutes?: number;
  /** The pane's size, when the pane reported one; the default otherwise. */
  viewport?: { width: number; height: number };
  /** Which of the workspace's Steel connectors may serve this session — the
   *  bound ones, or none (then the platform key). Decided by the spawn from
   *  the team's binding; see credential-scope.ts. */
  credentialScope: CredentialScope;
}): Promise<import('../../browser-sessions/types').BrowserSession> {
  const { getPool } = await import('../../infrastructure/database');
  const { randomUUID } = await import('crypto');
  const client = steelClient;
  const callerSessionId = `ui:${randomUUID()}`;
  const cred = await client.resolveCredential(args.tenantId, args.credentialScope);

  // The profile is handed in, named by the one rule every vendor shares, so
  // the same team (or the same person on a platform assistant) lands back in
  // the same browser whichever vendor serves it. A name with a row binds its
  // Steel id; a name without one has the session mint a profile, and either
  // way `persistProfile` saves what the session accumulates on release.
  const profileName = args.profile?.name ?? null;
  const known = profileName ? await client.ensureProfile(args.tenantId, profileName) : null;
  const minutes = Math.min(args.idleTimeoutMinutes ?? PANE_SESSION_MINUTES, PLAN_MAX_SESSION_MINUTES);

  // Through the classifier: a platform-key 402 (the account out of credit) has
  // to reach the pane as PlatformBrowserUnavailable so the proxy can fall to
  // the next platform vendor, and a tenant-key failure has to flip the
  // workspace's connector the way every other call on it would.
  const session = await client.withByokClassification(args.tenantId, cred, () =>
    client.call<SteelSession>('/sessions', cred.apiKey, {
      method: 'POST',
      body: {
        timeout: minutes * 60_000,
        inactivityTimeout: PANE_INACTIVITY_MS,
        dimensions: args.viewport ?? PANE_DIMENSIONS,
        ...(profileName ? { persistProfile: true } : {}),
        ...(known ? { profileId: known.id } : {}),
      },
    }));
  // The id of a freshly minted profile rides on the session. Read once more
  // from the vendor if the create response left it out, since the row below
  // is what lets the next session find the login again.
  const mintedProfileId = session.profileId
    ?? (profileName && !known
      ? (await client.call<SteelSession>(`/sessions/${encodeURIComponent(session.id)}`, cred.apiKey)
          .catch(() => null))?.profileId ?? null
      : null);
  const profile = known ?? (mintedProfileId && profileName ? { id: mintedProfileId, name: profileName } : null);
  if (!session.websocketUrl || !session.debugUrl) {
    const settled = await client.release(session.id, cred.apiKey);
    const { recordSettledSessionCost } = await import('../../browser-sessions/session-cost');
    await recordSettledSessionCost({
      vendor: 'steel',
      tenantId: args.tenantId,
      vendorSessionId: session.id,
      costUsd: steelSessionCostUsd(settled),
      settledAt: settled && settled.status !== 'live' ? new Date() : null,
      funding: steelFundingOf(cred),
      attribution: { agentId: args.agentId, threadId: args.threadId ?? undefined, invocationId: args.invocationId ?? undefined },
    }).catch((err: Error) => logger.warn(
      { err: err.message, vendor_session_id: session.id },
      'steel: abandoned session could not be settled',
    ));
    throw new SteelError('steel session created without websocketUrl/debugUrl', 502, session);
  }
  const liveViewUrl = steelLiveViewUrl(session.debugUrl);

  const pool = getPool();
  const insertResult = await pool.query(
    `INSERT INTO web_sessions (
       tenant_id, agent_id, thread_id, invocation_id, owner_account_id, caller_session_id,
       vendor, vendor_session_id, vendor_metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, 'steel', $7, $8)
     RETURNING *`,
    [
      args.tenantId, args.agentId, args.threadId, args.invocationId ?? null,
      args.ownerAccountId ?? null, callerSessionId,
      session.id,
      // funding is recorded on the session rather than re-derived later: a
      // connector connected or disconnected mid-session must not make a second
      // lookup disagree with the key that is actually driving this browser.
      JSON.stringify({
        cdp_url: session.websocketUrl,
        live_view_url: liveViewUrl,
        funding: steelFundingOf(cred),
      }),
    ],
  );
  // The reaper is armed for the earliest open session (reap-schedule.ts).
  armWebSessionReapFor(insertResult.rows[0]);
  const row = insertResult.rows[0] as Record<string, unknown>;
  // Recorded AFTER the session create succeeds, so a failed spawn never leaves
  // an orphan profile row pointing at a profile nobody can reach. profile_kind
  // matches the other vendors; vendor_profile_id holds Steel's id, since Steel
  // binds sessions by id. A session that asked for a profile and came back
  // without an id is logged rather than recorded: the login is lost for this
  // session only, and the next spawn mints again.
  //
  // The row FOLLOWS the vendor. A profile name is vendor-agnostic by design,
  // so one row per name is right; but every client reads its id back with
  // `vendor = '<self>'`, so an upsert that left `vendor` alone when another
  // vendor last served the name wrote this vendor's id under the other's name
  // and no client could read it: this one minted a fresh profile on every
  // spawn, the other tried to bind an id it never issued. The previous
  // vendor's profile stays at that vendor (a login someone saved there is
  // not ours to forget on a vendor change) and is logged so it can be found.
  if (args.profile && !profile) {
    logger.warn(
      { vendor_session_id: session.id, profile_name: args.profile.name },
      'steel: session created with persistProfile but reported no profileId; login will not persist',
    );
  }
  if (args.profile && profile) {
    const { rows: prev } = await pool.query<{ prev_vendor: string | null; prev_id: string | null }>(
      `WITH prev AS (
         SELECT vendor, vendor_profile_id FROM web_profiles
          WHERE tenant_id = $1 AND profile_name = $2
       )
       INSERT INTO web_profiles (tenant_id, profile_name, vendor, vendor_profile_id, owner_account_id, agent_id, profile_kind)
       VALUES ($1, $2, 'steel', $3, $4, $5, $6)
       ON CONFLICT (tenant_id, profile_name)
       DO UPDATE SET vendor            = EXCLUDED.vendor,
                     vendor_profile_id = EXCLUDED.vendor_profile_id,
                     owner_account_id  = EXCLUDED.owner_account_id,
                     agent_id          = EXCLUDED.agent_id,
                     profile_kind      = EXCLUDED.profile_kind,
                     updated_at        = now()
       RETURNING (SELECT vendor FROM prev) AS prev_vendor,
                 (SELECT vendor_profile_id FROM prev) AS prev_id`,
      [args.tenantId, args.profile.name, profile.id, args.profile.ownerAccountId, args.agentId, args.profile.kind],
    );
    const before = prev[0];
    if (before?.prev_vendor && before.prev_vendor !== 'steel') {
      logger.info(
        {
          tenantId: args.tenantId, profile_name: args.profile.name,
          previous_vendor: before.prev_vendor, previous_vendor_profile_id: before.prev_id,
          vendor_profile_id: profile.id, event: 'web_profile_vendor_switched',
        },
        'steel now serves a profile name another vendor held; the previous profile stays at that vendor',
      );
    }
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
