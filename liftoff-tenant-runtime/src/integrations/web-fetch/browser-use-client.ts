import { createHash } from 'crypto';
import { armWebSessionReapFor } from '../../browser-sessions/reap-schedule';
import { chromium } from 'playwright-core';
import { navigateForFetch } from './browser-navigation';
import { storedCdpUrl } from '../../browser-sessions/cdp-endpoint';
import { withPage as withPooledPage } from '../../browser-sessions/cdp-page';
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
import type {
  WebFetchAdvancedClient, WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
} from './types';

const BU_BASE_URL = 'https://api.browser-use.com/api/v2';
const BU_TIMEOUT_MS = 60_000;

// Session lifetime requested at create, in MINUTES. Browser Use charges the
// whole requested window upfront and refunds the unused remainder when the
// session is stopped, so this number costs nothing as long as every path
// stops the session. It is a ceiling against a leak, not a budget: the free
// tier caps a session at 15 minutes and paid at 240, and a request that
// exceeds the cap is refused rather than clamped.
const SESSION_TIMEOUT_MINUTES = 10;

/** A router-bound request: the tenant, and which of its connectors may serve
 *  (credential-scope.ts). Required, so the compiler refuses a call that has
 *  not decided it. */
type WithTenant<T> = T & { tenantId: string; credentialScope: CredentialScope };

/** A Browser Use credential plus the one fact every downstream decision needs:
 *  whose account paid for it.
 *
 *  Deliberately NOT `WebToolCredential`. That type promises a `connectorId`
 *  because every vendor using it is BYOK-only, and widening it would make the
 *  id optional for five vendors where it is always present — the compiler would
 *  then stop catching the case it exists to catch. */
export interface ResolvedCredential extends Omit<WebToolCredential, 'connectorId'> {
  /** The tenant's own connector, or null when the platform key served this
   *  call. Null is the funding signal; there is no second flag. */
  connectorId: string | null;
}

/** How a Browser Use call was funded, read off the one carrier.
 *
 *  `tenant_key` reproduces today's behaviour exactly: the workspace pays
 *  Browser Use directly, so the cost row is recorded for their analytics and
 *  debits no Operating Units. `platform` means we paid the vendor, so the row
 *  falls through to the customer-chargeable path like any other Liftoff cost. */
export function fundingOf(cred: ResolvedCredential): WebToolFunding {
  return cred.connectorId === null ? 'platform' : 'tenant_key';
}

export class BrowserUseError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly body?: unknown) {
    super(message);
    this.name = 'BrowserUseError';
  }
}

/** The PLATFORM's Browser Use key was refused, so no workspace connector is at
 *  fault and the BYOK envelope must not be raised.
 *
 *  BYOKVendorError tells a person to go top up their own vendor account. Told to
 *  someone browsing on OUR key, that is an instruction to fix an account they do
 *  not have, for a bill they are not paying. But the alternative that was there
 *  before this type existed was worse: the raw vendor error fell past every
 *  branch of classifyWebToolError and surfaced as "Failed to fetch URL", so the
 *  one failure that is entirely ours to fix was the one the person got no
 *  explanation for.
 *
 *  `retryable` separates the two cases an operator cares about. A concurrency
 *  ceiling or a vendor outage clears on its own and the turn should retry; an
 *  empty balance or a dead key does not, and needs a human on our side. */
export class PlatformBrowserUnavailable extends Error {
  constructor(
    public readonly code: VendorErrorCode,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformBrowserUnavailable';
  }
}

/** A money field as Browser Use actually sends it.
 *
 *  Their JSON carries browserCost and proxyCost as STRINGS, not numbers, to
 *  keep full precision: "0.0006666666666666666666666666666". TypeScript
 *  declaring them `number` does not make them one at runtime, and the failure
 *  is silent in the worst way — `(a ?? 0) + (b ?? 0)` CONCATENATES two strings
 *  into "0.00066666666666666666666666666660.00000289641320705413818359375",
 *  which then flows onward as a plausible-looking figure.
 *
 *  Downstream it becomes NaN at the first arithmetic: `Math.round(NaN)` writes
 *  a null cost to the usage ledger, and the control plane's bucket allocator
 *  computes `!(NaN > 0)` and returns no assignments — so the spend event is
 *  accepted with a 200 and no ledger row is ever written. A browser session
 *  billed nobody and nothing anywhere said so.
 *
 *  Returns null rather than 0 for anything unusable, because 0 is a claim that
 *  the session was free and null is the truth that we do not know. */
function vendorUsd(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Both meters, summed, or null when either is unreadable.
 *
 *  Proxy egress is charged on EVERY session whether or not one was asked for,
 *  and on a page pulling tens of megabytes it overtakes the hourly line, so
 *  metering browser time alone understates the bill without ever looking
 *  wrong. An absent field is a genuine zero; an unparseable one is not. */
function sessionCostUsd(s: { browserCost?: unknown; proxyCost?: unknown } | null): number | null {
  if (!s) return null;
  const browser = s.browserCost === undefined || s.browserCost === null ? 0 : vendorUsd(s.browserCost);
  const proxy   = s.proxyCost   === undefined || s.proxyCost   === null ? 0 : vendorUsd(s.proxyCost);
  if (browser === null || proxy === null) return null;
  return browser + proxy;
}

/** Shape of a session row from POST /browsers and GET|PATCH /browsers/:id.
 *  `liveUrl` and `cdpUrl` are populated while `status === 'active'` and go
 *  NULL the moment it stops, which is why the pane has to treat a stopped
 *  session as frameless rather than re-reading the URL it already had. */
interface BrowserUseSession {
  id: string;
  status: 'active' | 'stopped';
  liveUrl: string | null;
  cdpUrl: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** USD, already settled against the upfront charge once stopped.
   *
   *  Typed `unknown` deliberately: the vendor sends these as STRINGS to keep
   *  full precision, and declaring them `number` is how they came to be added
   *  with `+` and concatenated instead. Read them through sessionCostUsd. */
  browserCost?: unknown;
  /** USD of proxy egress. Billed on EVERY session, including ones that never
   *  asked for a proxy. Same string caveat as browserCost. */
  proxyCost?: unknown;
  proxyUsedMb?: unknown;
}


interface BrowserUseProfile {
  id: string;
  name: string;
  /** Origins this profile currently holds cookies for. Null until the profile
   *  has actually been used to log in somewhere. */
  cookieDomains: string[] | null;
  lastUsedAt: string | null;
}

export class BrowserUseClient implements WebFetchAdvancedClient {
  readonly vendor = 'browser_use' as const;

  supportsSessions(): boolean { return true; }

  /** Whose account pays for this session, decided in exactly one place.
   *
   *  A workspace that connected its own Browser Use key on /connections uses
   *  that key and is billed by Browser Use directly. A workspace that connected
   *  nothing gets the platform key, and we bill it for the browser time.
   *  Everything downstream keys off this one answer, so it must not be
   *  re-derived anywhere else.
   *
   *  The connector id IS the carrier. A tenant's own credential comes from a
   *  connector row and has one; the platform key does not, and null is the
   *  whole signal. A parallel boolean beside it would be a second fact that can
   *  disagree with the first.
   *
   *  A COOLING tenant key is deliberately NOT failed over to the platform key.
   *  Silently moving a workspace onto our key hides that their own account is
   *  out of credit or holding an invalid key, and starts charging them for a
   *  browser they are already paying for. VendorConnectorErrored therefore
   *  propagates; only "no connector at all" falls back. */
  async resolveCredential(tenantId: string, scope: CredentialScope): Promise<ResolvedCredential> {
    try {
      const cred = await getWebToolCredential(tenantId, 'browser_use', scope);
      return { ...cred, connectorId: cred.connectorId };
    } catch (err) {
      if (!(err instanceof VendorNotConnected)) throw err;
      return {
        apiKey: await getWebToolSecret('browser-use-api-key'),
        connectorId: null,
        extra: {},
      };
    }
  }

  classifyVendorError(error: unknown): VendorErrorCode | null {
    if (!(error instanceof BrowserUseError)) return null;
    const status = error.statusCode;
    // 402 is the balance floor: "You need at least $0.01 in credits to start a
    // browser session". It is the ONLY signal that an account has run dry —
    // there is no balance endpoint to poll — so it must classify, or a funded
    // tenant and an empty one look identical until the agent fails.
    if (status === 402) return 'insufficient_funds';
    if (status === 401 || status === 403) return 'invalid_key';
    // 429 here is the plan's CONCURRENCY ceiling ("Too many concurrent active
    // sessions"), not a request-rate limit. It clears when a sibling session
    // stops rather than after a fixed window, so it cools the credential the
    // same way and retries later.
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'vendor_down';
    return null;
  }

  /** Classify a vendor failure against the credential that actually made the
   *  call.
   *
   *  Every branch here acts on a CONNECTOR — cools it, marks it errored, tells
   *  the person to top up their own account. None of that has a subject when
   *  the platform key made the call: there is no connector row to flip, and the
   *  BYOK message would tell a workspace to go fix a Browser Use account it
   *  does not have. So a platform-funded failure is logged for operators and
   *  rethrown unchanged; it is our balance to fix, not theirs. */
  private async withByokClassification<T>(
    tenantId: string,
    cred: ResolvedCredential,
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
        // Loud, because nothing else will notice. There is no connector to flip
        // to `error` and no /connections badge to turn amber: a platform-key
        // failure is visible only in logs and in every workspace's browser
        // stopping at once.
        logger.error({
          tenantId, vendor: 'browser_use', classified,
          err: (err as Error).message,
          event: 'browser_use_platform_key_failed',
        }, 'the PLATFORM Browser Use key was rejected; no tenant connector is at fault');
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
        markCredentialCooling({
          tenantId, vendor: 'browser_use', connectorId, reason: 'rate_limited',
        });
      }
      if (classified === 'insufficient_funds' || classified === 'invalid_key') {
        await markConnectorErrored(
          tenantId, 'browser_use', connectorId, classified, (err as Error).message,
        );
        throw new BYOKVendorError(
          classified, 'browser_use', tenantId, connectorId,
          buildByokErrorMessage('browser_use', classified),
        );
      }
      throw err;
    }
  }

  /** Internal transport. Not private: the module-level thread-session factory
   *  below is part of this client's surface and needs it. */
  async call<T>(
    path: string,
    apiKey: string,
    init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
  ): Promise<T> {
    const res = await fetch(`${BU_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        'X-Browser-Use-API-Key': apiKey,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(BU_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const detail = (parsed as { detail?: unknown } | null)?.detail;
      throw new BrowserUseError(
        typeof detail === 'string' ? detail : `browser_use ${init.method} ${path} failed (${res.status})`,
        res.status,
        parsed,
      );
    }
    return parsed as T;
  }

  /** Total billed USD for a settled session, in micros.
   *
   *  Both meters are summed deliberately. Proxy egress is charged on every
   *  session at roughly $4.88/GB whether or not one was requested — a 52s
   *  visit to example.com billed $0.000028 of proxy against $0.000333 of
   *  browser time — and on a real page pulling tens of megabytes the proxy
   *  line overtakes the hourly one. Metering session time alone would
   *  understate the bill without ever looking wrong.
   *
   *  These are the vendor's own settled figures rather than an elapsed-time
   *  estimate, so the attributed cost matches the invoice exactly. */
  private costMicrosOf(session: BrowserUseSession): number {
    const usd = sessionCostUsd(session);
    if (usd === null) {
      // Loud, because the alternative is a silent zero on a call that cost
      // money. The caller reports 0 either way, but an operator can find this.
      logger.warn(
        { vendorSessionId: session.id, browserCost: session.browserCost, proxyCost: session.proxyCost },
        'browser_use returned a cost this code could not read; reporting 0',
      );
      return 0;
    }
    return Math.round(usd * 1_000_000);
  }

  /** Create a session and return it. Callers MUST stop it (see stopSession) —
   *  the whole requested window is charged upfront and only refunded on stop. */
  async createSession(tenantId: string, scope: CredentialScope): Promise<{ session: BrowserUseSession; cred: ResolvedCredential }> {
    const cred = await this.resolveCredential(tenantId, scope);
    const session = await this.withByokClassification(tenantId, cred, () =>
      this.call<BrowserUseSession>('/browsers', cred.apiKey, {
        method: 'POST',
        body: { timeout: SESSION_TIMEOUT_MINUTES },
      }),
    );
    if (!session.cdpUrl) {
      throw new BrowserUseError('browser_use session created without a cdpUrl', 502, session);
    }
    return { session, cred };
  }

  /** Stop a session and return its settled row (with final costs).
   *
   *  The stop verb is PATCH /browsers/:id, NOT the /sessions/:id the vendor
   *  docs show — that path 404s. Never allowed to throw: a failed stop must
   *  not mask the caller's real error, and the session expires on its own
   *  timeout regardless. */
  async stopSession(sessionId: string, apiKey: string): Promise<BrowserUseSession | null> {
    try {
      return await this.call<BrowserUseSession>(`/browsers/${sessionId}`, apiKey, {
        method: 'PATCH',
        body: { action: 'stop' },
      });
    } catch (err) {
      logger.warn(
        { vendorSessionId: sessionId, err: (err as Error).message },
        'browser_use session stop failed; it will expire on its own timeout',
      );
      return null;
    }
  }

  // ── Profiles ────────────────────────────────────────────────────────────
  //
  // A profile is the persistent cookie jar behind "the agent stays logged in".
  // Verified against the live API: a cookie set by a real Set-Cookie during one
  // session is present in the next session bound to the same profile, and the
  // profile's `cookieDomains` then names the origin.
  //
  // One trap worth knowing: cookies injected over CDP (Playwright's
  // addCookies) do NOT reach the profile store — only cookies the browser
  // received from a server do. A persistence check written with addCookies
  // reports a false negative.

  /** Browser Use caps profile names at 100 characters (422
   *  `string_too_long`). Ours is `liftoff-{tenantId}-{agentId}-{ownerAccountId}`
   *  — three UUIDs and a prefix, 118 characters — so it never fit, and every
   *  pane spawn for this vendor failed at ensureProfile before a session was
   *  ever created.
   *
   *  A short deterministic digest keeps the property that actually matters: the
   *  same (tenant, agent, owner) resolves to the same vendor profile, so a login
   *  is reused rather than a new profile being minted per spawn. The readable
   *  name is still what web_profiles stores and what web_session_forget takes,
   *  so nothing user-facing becomes a hash.
   *
   *  Names already under the cap are passed through unchanged, so this cannot
   *  silently rename an existing profile out from under a stored login. */
  static vendorProfileName(localName: string): string {
    if (localName.length <= 100) return localName;
    const digest = createHash('sha256').update(localName).digest('hex').slice(0, 32);
    return `liftoff-${digest}`;
  }

  /** Find-or-create by name.
   *
   *  Anchor creates a profile implicitly the first time a name is used, so a
   *  name is its own key. Browser Use requires an explicit create and then
   *  binds by UUID, so the deterministic name has to be resolved to an id here
   *  to keep the two vendors behaving the same way from the caller's side. */
  async ensureProfile(tenantId: string, profileName: string, scope: CredentialScope): Promise<{ id: string; name: string }> {
    const cred = await this.resolveCredential(tenantId, scope);
    // The vendor has a 100-character cap; the local name may exceed it.
    const vendorName = BrowserUseClient.vendorProfileName(profileName);

    // OUR OWN RECORD FIRST. web_profiles already stores the vendor id we minted
    // for this (tenant, agent, owner), and it is a single indexed row.
    //
    // The scan below is the fallback, and on the platform key it is the one
    // that does not scale: profiles accumulate for EVERY workspace on one
    // account, so a per-tenant page walk becomes a walk over the whole estate.
    // Past its ceiling the lookup silently missed and minted a duplicate
    // profile on every spawn, which loses the person's stored logins without
    // failing anything.
    const local = await this.storedProfileId(tenantId, profileName);
    if (local) return { id: local, name: vendorName };

    const existing = await this.findProfileByName(cred.apiKey, vendorName);
    if (existing) return { id: existing.id, name: existing.name };
    const created = await this.call<{ id: string; name: string }>('/profiles', cred.apiKey, {
      method: 'POST', body: { name: vendorName },
    });
    return { id: created.id, name: created.name };
  }

  /** The vendor profile id we recorded for this local profile name, if any.
   *
   *  Scoped to the tenant, so one workspace's row can never answer for
   *  another's even though the profiles may live on one shared account. */
  private async storedProfileId(tenantId: string, profileName: string): Promise<string | null> {
    try {
      const { getPool } = await import('../../infrastructure/database');
      const { rows } = await getPool().query<{ vendor_profile_id: string }>(
        `SELECT vendor_profile_id FROM web_profiles
          WHERE tenant_id = $1 AND profile_name = $2 AND vendor = 'browser_use'
          LIMIT 1`,
        [tenantId, profileName],
      );
      return rows[0]?.vendor_profile_id ?? null;
    } catch (err) {
      // A lookup failure must not cost the person their stored login: fall
      // through to the vendor scan, which is slower and still correct.
      logger.warn(
        { tenantId, profileName, err: (err as Error).message },
        'browser_use: stored profile lookup failed; falling back to a vendor scan',
      );
      return null;
    }
  }

  private async findProfileByName(
    apiKey: string,
    profileName: string,
  ): Promise<BrowserUseProfile | null> {
    // Walk the list to its END rather than to a fixed page count. A page cap is
    // indistinguishable from "not found", and "not found" here means a NEW
    // profile is created and the person's existing logins are orphaned. The
    // real bound is totalItems, which the vendor reports on every page, so the
    // loop terminates on the data rather than on a guess.
    //
    // PAGE_LIMIT remains only as a runaway guard against a vendor that reports
    // a totalItems it never delivers; crossing it is a bug, so it says so.
    const PAGE_SIZE = 50;
    const PAGE_LIMIT = 1_000;
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const res = await this.call<{ items: BrowserUseProfile[]; totalItems: number; pageSize: number }>(
        `/profiles?pageNumber=${page}&pageSize=${PAGE_SIZE}`, apiKey, { method: 'GET' },
      );
      const hit = res.items?.find((p) => p.name === profileName);
      if (hit) return hit;
      if (!res.items?.length || page * (res.pageSize || PAGE_SIZE) >= (res.totalItems ?? 0)) {
        return null;
      }
      if (page === PAGE_LIMIT) {
        logger.error(
          { profileName, pages: PAGE_LIMIT, totalItems: res.totalItems },
          'browser_use profile scan hit its runaway guard; a duplicate profile may be created',
        );
      }
    }
    return null;
  }

  /** Every profile on the tenant's account, with the domains each holds
   *  cookies for. `cookieDomains` has no Anchor equivalent — Anchor exposes
   *  only a name and description — so a person can actually see WHICH logins a
   *  profile is keeping rather than just that it exists. */
  async listProfiles(tenantId: string): Promise<Array<{ name: string; vendorProfileId: string; cookieDomains: string[] | null }>> {
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    const out: Array<{ name: string; vendorProfileId: string; cookieDomains: string[] | null }> = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.call<{ items: BrowserUseProfile[]; totalItems: number; pageSize: number }>(
        `/profiles?pageNumber=${page}&pageSize=50`, cred.apiKey, { method: 'GET' },
      );
      for (const p of res.items ?? []) {
        out.push({ name: p.name, vendorProfileId: p.id, cookieDomains: p.cookieDomains ?? null });
      }
      if (!res.items?.length || page * (res.pageSize || 50) >= (res.totalItems ?? 0)) break;
    }
    return out;
  }

  /** Delete by vendor id. Idempotent: a profile already gone is a success,
   *  because "forget this login" has been satisfied either way and surfacing a
   *  404 would leave a row the person cannot clear.
   *
   *  Tries the PLATFORM key too when the workspace's own key does not have the
   *  profile, and that second attempt is the whole point. A workspace that
   *  browsed on our key and later connected its own has profiles on BOTH
   *  accounts: the resolver now returns their key, their account 404s, and the
   *  404 used to be swallowed as success — so the local row disappeared while
   *  the real profile, holding their cookies, stayed on our account with
   *  nothing left pointing at it. "Forget this login" has to mean it. */
  async deleteProfile(vendorProfileId: string, tenantId: string): Promise<void> {
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    const deleted = await this.tryDeleteProfile(vendorProfileId, cred.apiKey);
    if (deleted) return;
    if (cred.connectorId === null) return; // already the platform key; nothing else to try
    const platformKey = await getWebToolSecret('browser-use-api-key').catch(() => null);
    if (!platformKey) return;
    const alsoDeleted = await this.tryDeleteProfile(vendorProfileId, platformKey);
    if (alsoDeleted) {
      logger.info(
        { tenantId, vendorProfileId, event: 'browser_use_platform_profile_reclaimed' },
        'forgot a login left on the platform account from before this workspace connected its own key',
      );
    }
  }

  /** True when the profile was deleted, false when the account does not have
   *  it. Anything else throws: a 500 is not evidence that a login is gone. */
  private async tryDeleteProfile(vendorProfileId: string, apiKey: string): Promise<boolean> {
    try {
      await this.call<null>(`/profiles/${vendorProfileId}`, apiKey, { method: 'DELETE' });
      return true;
    } catch (err) {
      if (err instanceof BrowserUseError && (err.statusCode === 404 || err.statusCode === 403)) {
        return false;
      }
      throw err;
    }
  }

  /** Look up a live session's CDP endpoint.
   *
   *  Anchor exposes goto / screenshot / active-page as REST verbs on its own
   *  API. Browser Use has no equivalent — it hands out a browser and nothing
   *  else — so every pane operation is a CDP round trip instead, and each one
   *  needs the endpoint re-read because cdpUrl is NULL on a stopped session. */
  private async cdpUrlFor(vendorSessionId: string, tenantId: string): Promise<string> {
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    const s = await this.call<BrowserUseSession>(`/browsers/${vendorSessionId}`, cred.apiKey, { method: 'GET' });
    if (s.status !== 'active' || !s.cdpUrl) {
      throw new BrowserUseError(`browser_use session ${vendorSessionId} is ${s.status}`, 410, s);
    }
    return s.cdpUrl;
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
    return withPooledPage('browser_use', vendorSessionId, tenantId, fn, opName);
  }

  /** No-ops, and correctly so.
   *
   *  pauseAgent/resumeAgent exist to stop ANCHOR's in-session agent, which
   *  drives the browser independently of us. Browser Use has no in-session
   *  agent — our own loop is the only thing driving it — so the takeover_state
   *  row is the entire mechanism: it gates our agent at tool dispatch. There is
   *  nothing on the vendor side to pause, and pretending otherwise by throwing
   *  would break takeover for this vendor entirely. */
  async pauseAgent(_vendorSessionId: string, _tenantId: string): Promise<void> { /* no vendor-side agent */ }

  async resumeAgent(_vendorSessionId: string, _tenantId: string): Promise<void> { /* no vendor-side agent */ }

  async gotoUrl(vendorSessionId: string, tenantId: string, url: string): Promise<void> {
    await this.withPage(vendorSessionId, tenantId, (page) =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: BU_TIMEOUT_MS }).then(() => undefined), 'gotoUrl');
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

  /** Page text as markdown. Anchor has a REST endpoint for this
   *  (/v1/tools/fetch-webpage against the live session); here it is the live
   *  DOM read over CDP, which is the same thing the person is looking at. */
  async fetchActivePageContent(vendorSessionId: string, tenantId: string): Promise<string> {
    const html = await this.withPage(vendorSessionId, tenantId, (page) => page.content(), 'fetchActivePageContent');
    return htmlToMarkdown(html);
  }

  /** Viewport screenshot, or the whole scrollable height when asked. Anchor
   *  routes full-height through a separate tools endpoint; Playwright takes a
   *  flag. */
  async fetchToolsScreenshot(
    vendorSessionId: string,
    tenantId: string,
    opts?: { captureFullHeight?: boolean },
  ): Promise<Buffer> {
    return this.withPage(vendorSessionId, tenantId, (page) =>
      page.screenshot({ type: 'png', fullPage: !!opts?.captureFullHeight }), 'fetchToolsScreenshot');
  }

  /** Current page as a PDF. Chromium only renders PDF in headless mode, and
   *  these sessions are headful so the person can watch, so this asks for the
   *  print stylesheet explicitly rather than silently returning a blank page. */
  async fetchActivePagePdf(vendorSessionId: string, tenantId: string): Promise<Buffer> {
    return this.withPage(vendorSessionId, tenantId, async (page) => {
      await page.emulateMedia({ media: 'print' });
      return page.pdf({ printBackground: true, format: 'A4' });
    }, 'fetchActivePagePdf');
  }

  /** Session stats for get_browser_session_stats. Shapes Browser Use's fields
   *  into the subset that tool reports; cost is the vendor's settled figure,
   *  summing browser time AND proxy egress for the reason costMicrosOf gives. */
  async getSessionDetails(vendorSessionId: string, tenantId: string): Promise<{
    status: string; startedAt: string; finishedAt: string | null;
    costUsd: number; proxyMb: number;
  }> {
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    const s = await this.call<BrowserUseSession>(`/browsers/${vendorSessionId}`, cred.apiKey, { method: 'GET' });
    return {
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      costUsd: sessionCostUsd(s) ?? 0,
      proxyMb: vendorUsd(s.proxyUsedMb) ?? 0,
    };
  }

  /** Hand an instruction to Browser Use's OWN agent, running inside the session
   *  the person is already watching.
   *
   *  This is the counterpart to AnchorClient.runAgentTask, and it is the reason
   *  the pane moves. The task is created against an EXISTING `sessionId`, so the
   *  work happens in the browser bound to this thread rather than in a fresh one
   *  nobody can see. `keep_alive` because the session outlives the task: a task
   *  created without a session closes it on completion, which would take the
   *  pane down mid-conversation.
   *
   *  Anchor answers synchronously and this API does not, so the poll is here
   *  rather than in the caller — the returned shape matches Anchor's exactly and
   *  no caller branches on vendor.
   *
   *  `stopped` is returned, not thrown. It is how a task ends when the agent
   *  gave up or a person stopped it, and the agent asking for the work is owed
   *  that answer rather than an exception. */
  async runAgentTask(
    vendorSessionId: string,
    tenantId: string,
    prompt: string,
    attribution?: import('../../browser-sessions/session-vendor-proxy').TaskAttribution,
  ): Promise<{ status: string; result?: unknown; data?: unknown }> {
    // Driven over THIS session's CDP, not through Browser Use's own agent.
    //
    // Their agent lives on API-V4 runs, and a run gets its own browser: their
    // docs state that no V4 endpoint accepts or exposes a cdpUrl for a run's
    // session. So a task there would act on a browser the person is not
    // watching, and passing this session's id to /tasks — which is what this
    // method used to do — answers "Session not found" while every CDP tool on
    // the same id works.
    // The one entry for every vendor (browser-task.ts): the Jev loop over
    // this session's own CDP url, Stagehand as the tail.
    const { runBrowserTask } = await import('./browser-task');
    // The endpoint recorded at creation first, as every page operation does:
    // the vendor is asked only when the row carries none. A task is the first
    // thing a run does with a browser it just opened, and the vendor has
    // answered "Session not found" for a session it created a second earlier
    // while the recorded endpoint drove it fine.
    const stored = await storedCdpUrl(vendorSessionId);
    if (stored) {
      return runBrowserTask({ vendor: 'browser_use', vendorSessionId, cdpUrl: stored, prompt, tenantId, ...attribution });
    }
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    const session = await this.call<BrowserUseSession>(
      `/browsers/${vendorSessionId}`, cred.apiKey, { method: 'GET' },
    );
    if (!session.cdpUrl) {
      throw new BrowserUseError(
        `browser_use session ${vendorSessionId} has no cdpUrl to drive`, 502, session,
      );
    }
    return runBrowserTask({ vendor: 'browser_use', vendorSessionId, cdpUrl: session.cdpUrl, prompt, tenantId, ...attribution });
  }

  /** Stop a pane session and record what it cost.
   *
   *  Signature matches AnchorClient.closeSession so the vendor proxy can
   *  dispatch to either without adapting arguments.
   *
   *  The metering is HERE rather than in the pane tool handlers because this is
   *  the only moment the figure exists: Browser Use charges the whole requested
   *  window upfront and reconciles it on stop, so a session's real cost is not
   *  knowable until it is stopped. Every path that ends a session — the agent's
   *  web_session_close, the person closing the pane, the expiry reaper, tenant
   *  teardown — comes through here, so one call site covers all of them.
   *
   *  Recording never blocks the close. A close that failed because billing was
   *  unavailable would leave a paid session running and holding a concurrency
   *  slot, which is strictly worse than an unrecorded one. */
  async closeSession(vendorSessionId: string, tenantId: string): Promise<void> {
    const cred = await this.resolveCredential(tenantId, ANY_CONNECTOR);
    const stopped = await this.stopSession(vendorSessionId, cred.apiKey);
    // A stop that failed does not mean the session is unsettled: the usual
    // cause is that something already stopped it, and the settled row is still
    // readable. Re-read before giving up, or the common double-close loses the
    // figure entirely.
    const settled = stopped?.finishedAt
      ? stopped
      : await this.call<BrowserUseSession>(
          `/browsers/${vendorSessionId}`, cred.apiKey, { method: 'GET' },
        ).catch(() => null);
    try {
      const { recordSettledSessionCost } = await import('../../browser-sessions/session-cost');
      await recordSettledSessionCost({
        vendor: 'browser_use',
        tenantId,
        vendorSessionId,
        costUsd: sessionCostUsd(settled),
        settledAt: settled?.finishedAt ? new Date(settled.finishedAt) : null,
        funding: fundingOf(cred),
        breakdown: {
          browser_cost_usd: vendorUsd(settled?.browserCost) ?? 0,
          proxy_cost_usd: vendorUsd(settled?.proxyCost) ?? 0,
          proxy_used_mb: vendorUsd(settled?.proxyUsedMb) ?? 0,
        },
      });
    } catch (err) {
      logger.warn(
        { vendor_session_id: vendorSessionId, err: (err as Error).message },
        'browser_use session stopped but its cost could not be recorded',
      );
    }
  }

  async fetch(req: WithTenant<WebFetchAdvancedRequest>): Promise<InternalWebFetchAdvancedResult> {
    const { session, cred } = await this.createSession(req.tenantId, req.credentialScope);
    let html: string;
    let finalUrl: string;
    try {
      const browser = await chromium.connectOverCDP(session.cdpUrl!);
      try {
        const ctx = browser.contexts()[0] ?? await browser.newContext();
        const page = ctx.pages()[0] ?? await ctx.newPage();
        await navigateForFetch(page, req.url, BU_TIMEOUT_MS);
        if (req.waitFor?.type === 'selector')          await page.waitForSelector(req.waitFor.value, { timeout: 10_000 });
        else if (req.waitFor?.type === 'networkidle')  await page.waitForLoadState('networkidle', { timeout: 10_000 });
        else if (req.waitFor?.type === 'time')         await page.waitForTimeout(req.waitFor.ms);
        html = await page.content();
        finalUrl = page.url();
      } finally {
        await browser.close();
      }
    } finally {
      // Always, on every path. An unstopped session keeps the full upfront
      // charge and holds one of the plan's concurrency slots until its
      // timeout, which starves every other tenant on the same key.
      await this.stopSession(session.id, cred.apiKey);
    }
    const settled = await this.call<BrowserUseSession>(`/browsers/${session.id}`, cred.apiKey, { method: 'GET' })
      .catch(() => null);
    return {
      content: htmlToMarkdown(html),
      finalUrl,
      sessionId: req.sessionId,
      liveViewUrl: session.liveUrl ?? undefined,
      vendor: 'browser_use',
      costMicros: settled ? this.costMicrosOf(settled) : 0,
      jsRendered: true,
      // The credential that actually created THIS session, not a second lookup
      // of the tenant's connector state. A connector disconnected mid-call
      // would make those two disagree, and the charge has to follow the key
      // that paid.
      funding: fundingOf(cred),
    };
  }
}

/** Spawn a Browser Use session bound to a chat thread and record it.
 *
 *  Counterpart to createAnchorSessionForThread. Two deliberate differences:
 *
 *  Profiles are bound the same way Anchor binds them: one per
 *  (tenant, agent, owner), so a login the person completes in the pane survives
 *  across threads, recorded in web_profiles so it stays listable via
 *  web_session_list and deletable via web_session_forget. An ownerless caller
 *  gets an ephemeral browser, because a shared persistent login store with no
 *  owner is nobody's to forget.
 *
 *  The idle window is the session timeout. Anchor takes a separate max_duration
 *  and idle_timeout; Browser Use takes one `timeout` and charges it upfront,
 *  refunding the remainder on stop, so the number here is a ceiling rather than
 *  a reservation.
 */
export async function createBrowserUseSessionForThread(args: {
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
  /** Which of the workspace's Browser Use connectors may serve this session —
   *  the bound ones, or none (then the platform key). Decided by the spawn
   *  from the team's binding; see credential-scope.ts. */
  credentialScope: CredentialScope;
}): Promise<import('../../browser-sessions/types').BrowserSession> {
  const { getPool } = await import('../../infrastructure/database');
  const { randomUUID } = await import('crypto');
  const client = new BrowserUseClient();
  const callerSessionId = `ui:${randomUUID()}`;
  // Through the ONE resolver, so a pane session is funded by the same rule a
  // tool call is. Reading the connector directly here is what made this the
  // only path that could not use the platform key.
  const cred = await client.resolveCredential(args.tenantId, args.credentialScope);

  // The profile is handed in, named by the one rule every vendor shares, so
  // the same team (or the same person on a platform assistant) lands back in
  // the same browser whichever vendor serves it.
  const ownerProfileName = args.profile?.name ?? null;
  const profile = ownerProfileName
    ? await client.ensureProfile(args.tenantId, ownerProfileName, args.credentialScope)
    : null;

  const session = await client.call<BrowserUseSession>('/browsers', cred.apiKey, {
    method: 'POST',
    body: {
      timeout: args.idleTimeoutMinutes ?? SESSION_TIMEOUT_MINUTES,
      ...(profile ? { profileId: profile.id } : {}),
    },
  });
  if (!session.cdpUrl || !session.liveUrl) {
    // Stop it rather than leaking a paid, slot-holding session we cannot drive.
    const settled = await client.stopSession(session.id, cred.apiKey);
    // Settle it too. The vendor opened a browser and charged for the window, so
    // the money is real even though the spawn failed — and this is the one path
    // that never writes a web_sessions row, so the attribution has to be handed
    // over rather than looked up. Without it, "every stopped session is
    // recorded" would hold everywhere except the case that throws.
    const { recordSettledSessionCost } = await import('../../browser-sessions/session-cost');
    await recordSettledSessionCost({
      vendor: 'browser_use',
      tenantId: args.tenantId,
      vendorSessionId: session.id,
      costUsd: sessionCostUsd(settled),
      settledAt: settled?.finishedAt ? new Date(settled.finishedAt) : null,
      funding: fundingOf(cred),
      attribution: { agentId: args.agentId, threadId: args.threadId ?? undefined, invocationId: args.invocationId ?? undefined },
    }).catch((err: Error) => logger.warn(
      { err: err.message, vendor_session_id: session.id },
      'browser_use: abandoned session could not be settled',
    ));
    throw new BrowserUseError('browser_use session created without cdpUrl/liveUrl', 502, session);
  }

  const pool = getPool();
  const insertResult = await pool.query(
    `INSERT INTO web_sessions (
       tenant_id, agent_id, thread_id, invocation_id, owner_account_id, caller_session_id,
       vendor, vendor_session_id, vendor_metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, 'browser_use', $7, $8)
     RETURNING *`,
    [
      args.tenantId, args.agentId, args.threadId, args.invocationId ?? null,
      args.ownerAccountId ?? null, callerSessionId,
      session.id,
      // funding is recorded on the session, not re-derived later: a connector
      // connected or disconnected mid-session would make a second lookup
      // disagree with the key that is actually driving this browser.
      JSON.stringify({
        cdp_url: session.cdpUrl,
        live_view_url: session.liveUrl,
        funding: fundingOf(cred),
      }),
    ],
  );
  // The reaper is armed for the earliest open session (reap-schedule.ts).
  armWebSessionReapFor(insertResult.rows[0]);
  const row = insertResult.rows[0] as Record<string, unknown>;
  // Recorded AFTER the session create succeeds, so a failed spawn never leaves
  // an orphan profile row pointing at a login nobody can reach. profile_kind
  // 'pane' matches Anchor's: one browser per (tenant, agent, owner) that may
  // accumulate many site logins, as distinct from a deliberate per-site 'saved'
  // profile. vendor_profile_id holds the vendor's UUID here rather than the
  // name, because Browser Use binds sessions by id while Anchor binds by name.
  if (args.profile && profile) {
    await pool.query(
      `INSERT INTO web_profiles (tenant_id, profile_name, vendor, vendor_profile_id, owner_account_id, agent_id, profile_kind)
       VALUES ($1, $2, 'browser_use', $3, $4, $5, $6)
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
    liveViewUrl: session.liveUrl,
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
