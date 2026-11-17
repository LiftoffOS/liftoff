import { randomUUID } from 'node:crypto';
import { armWebSessionReapFor } from '../../browser-sessions/reap-schedule';
import { chromium } from 'playwright-core';
import { navigateForFetch } from './browser-navigation';
import { logger } from '../../infrastructure/logging';
import { ANY_CONNECTOR, type CredentialScope } from './credential-scope';
import { getWebToolCredential, type WebToolCredential } from './web-tool-secrets';
import { getPool } from '../../infrastructure/database';
import { storedCdpUrl } from '../../browser-sessions/cdp-endpoint';
import { htmlToMarkdown } from './markdown';
import { BYOKVendorError, type VendorErrorCode } from './types';
import { buildByokErrorMessage, markConnectorErrored } from './byok-error-handler';
import { observeVendorResponse } from './credential-pool';
import type {
  WebFetchAdvancedClient, WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
  WebExtractRequest, InternalWebExtractResult,
  WebTaskRequest, InternalWebTaskResult,
  WebIdentityConnectRequest, InternalWebIdentityConnectResult,
} from './types';

const ANCHOR_BASE_URL = 'https://api.anchorbrowser.io';
const ANCHOR_TIMEOUT_MS = 60_000;
const USD_PER_BROWSER_HR = 0.05;
const USD_PER_BROWSER    = 0.01;

// Anchor bills in credits, not USD directly. 1 task = 0.1 credit = $0.01 →
// 1 credit = $0.10. Convert credits_used deltas (from GET /v1/billing) into
// USD micros for the OU ledger.
const ANCHOR_USD_PER_CREDIT = 0.10;

// The live GET /v1/billing response is FLAT (verified live):
//   { credits, credits_used, included_credits, tier, ... }
// — NOT wrapped under `data`. We accept both shapes (flat first, `data` fallback)
// so a server-side shape change in either direction can't break cost capture.
interface AnchorBillingResponse {
  credits?: number;
  credits_used?: number;
  included_credits?: number;
  billing_period?: string;
  tier?: string;
  data?: {
    credits?: number;
    credits_used?: number;
    included_credits?: number;
    billing_period?: string;
    tier?: string;
  };
}

interface AnchorCreateSessionResponse {
  data: { id: string; cdp_url: string; live_view_url: string };
}

export class AnchorError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly body?: unknown) {
    super(message); this.name = 'AnchorError';
  }
}

/** A router-bound request: the tenant, and which of its connectors may serve
 *  (credential-scope.ts). Required, so the compiler refuses a call that has
 *  not decided it. */
type WithTenant<T> = T & { tenantId: string; agentId?: string; credentialScope: CredentialScope };

export class AnchorClient implements WebFetchAdvancedClient {
  readonly vendor = 'anchor' as const;

  supportsSessions(): boolean { return true; }

  private async credential(tenantId: string, scope: CredentialScope): Promise<WebToolCredential> {
    return getWebToolCredential(tenantId, 'anchor_browser', scope);
  }

  classifyVendorError(error: unknown): VendorErrorCode | null {
    if (!(error instanceof AnchorError)) return null;
    const status = error.statusCode;
    if (status === 401 || status === 403) return 'invalid_key';
    if (status === 402) return 'insufficient_funds';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'vendor_down';
    return null;
  }

  async fetch(req: WithTenant<WebFetchAdvancedRequest>): Promise<InternalWebFetchAdvancedResult> {
    const tenantId = req.tenantId;
    const agentId  = req.agentId ?? '';
    if (!req.sessionId) {
      // Web Unlocker — ephemeral browser per call.
      const startMs = Date.now();
      const text = await this.callText('/v1/tools/fetch-webpage', {
        url: req.url,
        format: 'markdown',
      }, tenantId, req.credentialScope);
      const elapsedMs = Date.now() - startMs;
      if (!text) throw new AnchorError('Anchor Web Unlocker returned empty content', 200);
      return {
        content: text,
        finalUrl: req.url,
        sessionId: undefined,
        vendor: 'anchor',
        costMicros: Math.round((USD_PER_BROWSER + (elapsedMs / 3_600_000) * USD_PER_BROWSER_HR) * 1_000_000),
        jsRendered: true,
      };
    }
    const { cdpUrl, liveViewUrl, isNew } = await this.ensureSession(req.sessionId, tenantId, agentId, req.credentialScope, req.vendorProfileId, req.vendorIdentityId);
    const startMs = Date.now();
    const browser = await chromium.connectOverCDP(cdpUrl);
    try {
      const ctx = browser.contexts()[0] ?? await browser.newContext();
      const page = ctx.pages()[0] ?? await ctx.newPage();
      await navigateForFetch(page, req.url, ANCHOR_TIMEOUT_MS);
      if (req.waitFor?.type === 'selector')    await page.waitForSelector(req.waitFor.value, { timeout: 10_000 });
      else if (req.waitFor?.type === 'networkidle') await page.waitForLoadState('networkidle', { timeout: 10_000 });
      else if (req.waitFor?.type === 'time')   await page.waitForTimeout(req.waitFor.ms);

      const finalUrl = page.url();
      const elapsedMs = Date.now() - startMs;
      const costMicros = Math.round(
        ((isNew ? USD_PER_BROWSER : 0) + (elapsedMs / 3_600_000) * USD_PER_BROWSER_HR) * 1_000_000,
      );

      // Handoff detection: did we land on a login screen on a different host?
      const reqHost = new URL(req.url).hostname;
      const finalHost = new URL(finalUrl).hostname;
      const looksLikeLogin = /\/(login|signin|oauth|auth|sso)\b/i.test(finalUrl);
      if (looksLikeLogin && finalHost !== reqHost) {
        return {
          content: '',
          finalUrl,
          sessionId: req.sessionId,
          liveViewUrl,
          requiresUserIntervention: {
            reason: `Authentication required at ${finalHost}`,
            resumeHint: 'Ask the user to complete login at liveViewUrl, then call this tool again with the same sessionId.',
          },
          vendor: 'anchor',
          costMicros,
          jsRendered: true,
        };
      }

      const html = await page.content();
      return {
        content: htmlToMarkdown(html),
        finalUrl,
        sessionId: req.sessionId,
        liveViewUrl,
        vendor: 'anchor',
        costMicros,
        jsRendered: true,
      };
    } finally {
      await browser.close();
    }
  }

  async extract(req: WithTenant<WebExtractRequest>): Promise<InternalWebExtractResult> {
    const startMs = Date.now();
    const data = await this.callJson<{ data: { result: unknown } }>('/v1/tools/perform-web-task', {
      url: req.url,
      prompt: req.prompt ?? `Extract data matching this schema from the page: ${JSON.stringify(req.schema)}`,
      output_schema: req.schema,
      max_steps: 30,
    }, 'POST', req.tenantId, req.credentialScope);
    const elapsedMs = Date.now() - startMs;
    return {
      data: data.data.result,
      finalUrl: req.url,
      vendor: 'anchor',
      costMicros: Math.round((USD_PER_BROWSER + (elapsedMs / 3_600_000) * USD_PER_BROWSER_HR) * 1_000_000),
      jsRendered: true,
    };
  }

  async task(req: WithTenant<WebTaskRequest>): Promise<InternalWebTaskResult> {
    const startMs = Date.now();
    const tenantId = req.tenantId;
    const agentId  = req.agentId ?? '';

    let vendorSessionId: string | undefined;
    let createdSessionLocally = false;
    if (req.sessionId) {
      // ensureSession needs an agentId — it's stored on the web_sessions row
      // so the session reaper / janitor can correlate cost back to the agent.
      // The router supplies both from ctx; this is a defensive guard for
      // direct callers that bypass the router.
      if (!agentId) {
        throw new AnchorError('web_task with session_id requires agentId context', 0);
      }
      const session = await this.ensureSession(
        req.sessionId, tenantId, agentId, req.credentialScope, req.vendorProfileId, req.vendorIdentityId,
        req.threadId,
      );
      createdSessionLocally = session.isNew;
      vendorSessionId = await this.lookupVendorSessionId(req.sessionId, tenantId);
    }

    // PR2: prepend oversight triggers + agent userInstructions to the prompt
    // (Anchor's /v1/tools/perform-web-task doesn't accept extended_system_message,
    // so triggers must land inline at the top of the task content). Enable
    // human_intervention=true so Anchor's in-session agent can ask follow-up
    // questions via webhook; we route them into our /review queue.
    const triggers = agentId ? await loadOversightTriggers(tenantId, agentId) : [];
    const data = await this.callJson<{ data: { result: unknown } }>('/v1/tools/perform-web-task', {
      prompt: composeTaskPrompt(req.task, triggers),
      ...(req.startingUrl ? { url: req.startingUrl } : {}),
      ...(req.outputSchema ? { output_schema: req.outputSchema } : {}),
      max_steps: req.maxSteps ?? 50,
      human_intervention: true,
      ...(vendorSessionId ? { session_id: vendorSessionId } : {}),
    }, 'POST', tenantId, req.credentialScope);
    if (data.data.result == null || data.data.result === '') {
      throw new AnchorError('Anchor perform-web-task completed with empty result', 200);
    }
    const elapsedMs = Date.now() - startMs;
    return {
      result: data.data.result,
      sessionId: req.sessionId,
      vendor: 'anchor',
      costMicros: Math.round((USD_PER_BROWSER + (elapsedMs / 3_600_000) * USD_PER_BROWSER_HR) * 1_000_000),
      createdSessionLocally,
    };
  }

  private async lookupVendorSessionId(callerSessionId: string, tenantId: string): Promise<string | undefined> {
    const r = await getPool().query<{ vendor_session_id: string }>(
      `SELECT vendor_session_id FROM web_sessions
       WHERE caller_session_id = $1 AND tenant_id = $2 AND vendor = 'anchor' AND closed_at IS NULL`,
      [callerSessionId, tenantId],
    );
    return r.rows[0]?.vendor_session_id;
  }

  async identityCreate(req: WithTenant<WebIdentityConnectRequest>): Promise<InternalWebIdentityConnectResult> {
    const { result: identity, costMicros } = await this.measureExactCreditDelta(
      req.tenantId,
      () => this.callJson<{ data: { id: string; token: string } }>(
        '/v1/identities',
        {
          name: req.identityName,
          source: req.loginUrl,
          credentials: (req.credentialTypes ?? ['username_password']).map(t => ({ type: t })),
          metadata: { application_name: req.serviceName },
        },
        'POST',
        req.tenantId,
        req.credentialScope,
      ),
    );
    return {
      connectUrl: `https://app.anchorbrowser.io/identity/create?token=${identity.data.token}`,
      identityName: req.identityName,
      vendorIdentityId: identity.data.id,
      vendor: 'anchor',
      costMicros,
    };
  }

  async deleteIdentity(vendorIdentityId: string, tenantId: string): Promise<void> {
    const cred = await this.credential(tenantId, ANY_CONNECTOR);
    await fetch(`${ANCHOR_BASE_URL}/v1/identities/${vendorIdentityId}`, {
      method: 'DELETE',
      headers: { 'anchor-api-key': cred.apiKey },
    }).catch(e => logger.warn('anchor identity delete failed', { vendorIdentityId, error: (e as Error).message }));
  }

  async createProfileFromSession(
    vendorSessionId: string,
    profileName: string,
    tenantId: string,
    opts?: { ownerAccountId?: string; agentId?: string; serviceName?: string; loginUrl?: string },
  ): Promise<{ profileName: string; costMicros: number }> {
    // Anchor's create-profile response is { data: { status: 'success' } } — it
    // does NOT echo an id or name (verified live), so the reuse key
    // we persist is the NAME WE PASSED (the same value the pane path uses),
    // never a field off the response.
    //
    // dedicated_sticky_ip is intentionally NOT requested here. It only takes
    // effect on the direct-create + session-USE flow; on this source:'session'
    // snapshot path Anchor does not reliably apply it (verified live), and
    // pre-creating a sticky profile just wastes a dedicated-IP allocation the
    // snapshot then drops. Sticky IP is therefore not offered for saved logins
    // (dedicated_sticky_ip stays false on the row).
    const { costMicros } = await this.measureExactCreditDelta(
      tenantId,
      () => this.callJson(
        '/v1/profiles',
        { name: profileName, source: 'session', session_id: vendorSessionId, description: `Tenant ${tenantId}` },
        'POST',
        tenantId,
        ANY_CONNECTOR,
      ),
    );
    // vendor_profile_id = the name we passed (Anchor's reuse key); profile_kind
    // defaults to 'saved'. last_used_at is intentionally NOT set here — it tracks
    // genuine reuse, not creation (list ordering falls back to created_at).
    await getPool().query(
      `INSERT INTO web_profiles
         (tenant_id, profile_name, vendor, vendor_profile_id, owner_account_id, agent_id,
          service_name, login_url, dedicated_sticky_ip)
       VALUES ($1, $2, 'anchor', $2, $3, $4, $5, $6, false)
       ON CONFLICT (tenant_id, profile_name)
       DO UPDATE SET vendor           = EXCLUDED.vendor,
                     vendor_profile_id = EXCLUDED.vendor_profile_id,
                     owner_account_id = COALESCE(EXCLUDED.owner_account_id, web_profiles.owner_account_id),
                     agent_id         = COALESCE(EXCLUDED.agent_id, web_profiles.agent_id),
                     service_name     = COALESCE(EXCLUDED.service_name, web_profiles.service_name),
                     login_url        = COALESCE(EXCLUDED.login_url, web_profiles.login_url),
                     profile_kind     = 'saved',
                     updated_at       = now()`,
      [
        tenantId, profileName, opts?.ownerAccountId ?? null, opts?.agentId ?? null,
        opts?.serviceName ?? null, opts?.loginUrl ?? null,
      ],
    );
    return { profileName, costMicros };
  }

  /** Stop a pane session and record what it cost.
   *
   *  The metering is HERE rather than in the pane tool handlers because this is
   *  the only moment the figure is final: Anchor bills a session by the hour
   *  while it runs, and `credits_used` on the session record is not settled
   *  until it ends. Every path that ends a session — the agent's
   *  web_session_close, the person closing the pane, the expiry reaper, tenant
   *  teardown — comes through here, so one call site covers all of them.
   *
   *  Read AFTER the delete, because that is when the number stops moving.
   *  Anchor keeps the session record after deletion, so the read still answers;
   *  when it does not, the session is logged as unsettled rather than billed
   *  from a figure that was still climbing.
   *
   *  Recording never blocks the close. A close that failed because billing was
   *  unavailable would leave a paid session running and holding a concurrency
   *  slot, which is strictly worse than an unrecorded one. */
  async closeSession(vendorSessionId: string, tenantId: string): Promise<void> {
    const cred = await this.credential(tenantId, ANY_CONNECTOR);
    await fetch(`${ANCHOR_BASE_URL}/v1/sessions/${vendorSessionId}`, {
      method: 'DELETE',
      headers: { 'anchor-api-key': cred.apiKey },
    }).catch(e => logger.warn('anchor session close failed', { vendorSessionId, error: (e as Error).message }));

    try {
      const details = await this.getSessionDetails(vendorSessionId, tenantId).catch(() => null);
      const { recordSettledSessionCost } = await import('../../browser-sessions/session-cost');
      await recordSettledSessionCost({
        vendor: 'anchor',
        tenantId,
        vendorSessionId,
        costUsd: details?.creditsUsed != null
          ? details.creditsUsed * ANCHOR_USD_PER_CREDIT
          : null,
        // Anchor reports no end timestamp on the session record, so the settle
        // instant is when WE stopped it. Stable across a double close in the
        // only way that matters: the second attempt finds the row already
        // closed and never reaches here, and if it did the control plane dedups
        // on the source id.
        settledAt: details?.creditsUsed != null ? new Date() : null,
        // Anchor is BYOK-only. Every session runs on the workspace's own Anchor
        // account, so the row is recorded for their analytics and debits no
        // Operating Units — the same treatment every strict vendor gets.
        funding: 'tenant_key',
        breakdown: {
          credits_used: details?.creditsUsed ?? 0,
          duration_sec: details?.durationSec ?? 0,
          proxy_bytes: details?.proxyBytes ?? 0,
        },
      });
    } catch (err) {
      logger.warn('anchor session stopped but its cost could not be recorded', {
        vendorSessionId, error: (err as Error).message,
      });
    }
  }

  /** GET /v1/profiles — the saved profiles on the tenant's Anchor account.
   *  Backs web_session_list. Anchor wraps list responses inconsistently
   *  ({ data: { items } } | { data: [...] } | bare array), so normalize. */
  async listProfiles(tenantId: string): Promise<Array<{ name: string; description: string | null }>> {
    const res = await this.callJson<unknown>('/v1/profiles', undefined, 'GET', tenantId, ANY_CONNECTOR);
    const raw = Array.isArray(res)
      ? res
      : ((res as { data?: { items?: unknown[] } } | null)?.data?.items
        ?? (res as { data?: unknown[] } | null)?.data);
    const items = Array.isArray(raw) ? raw : [];
    return items.map((p) => {
      const it = p as Record<string, unknown>;
      return {
        name: String(it.name ?? ''),
        description: typeof it.description === 'string' ? it.description : null,
      };
    });
  }

  /** DELETE /v1/profiles/{name} — Anchor addresses profiles by name. 404 is
   *  tolerated (already gone) so web_session_forget stays idempotent. */
  async deleteProfile(profileName: string, tenantId: string): Promise<void> {
    const cred = await this.credential(tenantId, ANY_CONNECTOR);
    let res: Response;
    try {
      res = await fetch(`${ANCHOR_BASE_URL}/v1/profiles/${encodeURIComponent(profileName)}`, {
        method: 'DELETE',
        headers: { 'anchor-api-key': cred.apiKey },
        signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
      });
    } catch (e) {
      throw new AnchorError(`Network: ${(e as Error).message}`, 0);
    }
    if (!res.ok && res.status !== 404) throw await this.classifyAndThrow(res, tenantId, cred);
  }

  private async ensureSession(
    callerSessionId: string,
    tenantId: string,
    agentId: string,
    /** Which of the workspace's Anchor connectors may serve a NEW session
     *  (credential-scope.ts); an existing session is driven from its row. */
    scope: CredentialScope,
    vendorProfileId?: string,
    vendorIdentityId?: string,
    threadId?: string,
  ): Promise<{ cdpUrl: string; liveViewUrl: string; isNew: boolean }> {
    const pool = getPool();
    const existing = await pool.query(
      `SELECT vendor_metadata FROM web_sessions
       WHERE caller_session_id = $1 AND tenant_id = $2 AND vendor = 'anchor' AND closed_at IS NULL`,
      [callerSessionId, tenantId],
    );
    if (existing.rows.length > 0) {
      const meta = existing.rows[0].vendor_metadata;
      await pool.query(
        `UPDATE web_sessions
            SET last_used_at = now(),
                -- GREATEST, because this is one holder touching a session
                -- another may be holding for longer: a task that carried on
                -- takes a lease out to its own deadline, and a flat reset
                -- here would hand the browser back under it.
                expires_at   = GREATEST(COALESCE(expires_at, now()), now() + INTERVAL '10 minutes')
          WHERE caller_session_id = $1 AND tenant_id = $2`,
        [callerSessionId, tenantId],
      );
      return { cdpUrl: meta.cdp_url, liveViewUrl: meta.live_view_url, isNew: false };
    }
    // Switch from POST /v1/sessions (sync) to POST /v1/sessions/async
    // (non-blocking) + status poll. Observable behaviour is identical:
    // ensureSession still awaits a ready session before returning the
    // metadata downstream callers need. The change is that the pod
    // spawn is documented through Anchor's canonical async path, which
    // lets us upstream future improvements (longer pod warm-up, queued
    // provisioning) without re-plumbing.
    const asyncBody: Parameters<typeof this.createSessionAsync>[1] = {
      session: { timeout: { max_duration: 60, idle_timeout: 10 } } as Record<string, unknown>,
      browser: {
        adblock: { active: true },
        captcha_solver: { active: true },
        headless: { active: true },
        extra_stealth: { active: true },
        // persist: true so cookies refreshed during this run are saved back to
        // the named profile — otherwise a reused login slowly decays as tokens
        // rotate and the saved snapshot goes stale.
        ...(vendorProfileId ? { profile: { name: vendorProfileId, persist: true } } : {}),
      },
      ...(vendorIdentityId ? { identities: [{ id: vendorIdentityId }] } : {}),
    };
    const { requestId } = await this.createSessionAsync(tenantId, asyncBody, scope);
    // Poll the status endpoint until the pod is up. Capped at the
    // surrounding ANCHOR_TIMEOUT_MS so a wedged spawn doesn't hang
    // ensureSession forever.
    const POLL_INTERVAL_MS = 500;
    const POLL_DEADLINE_MS = Date.now() + ANCHOR_TIMEOUT_MS;
    let asyncResolved: Awaited<ReturnType<typeof this.pollAsyncSessionStatus>> | null = null;
    while (Date.now() < POLL_DEADLINE_MS) {
      const next = await this.pollAsyncSessionStatus(tenantId, requestId, scope);
      if (next.status === 'ready' && next.sessionId) {
        asyncResolved = next;
        break;
      }
      if (next.status === 'failed' || next.status === 'error') {
        throw new AnchorError(`createSession async failed: status=${next.status}`, 500);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (!asyncResolved) {
      throw new AnchorError(`createSession async did not reach ready within ${ANCHOR_TIMEOUT_MS}ms`, 504);
    }
    // Shape into the same response envelope the rest of this method
    // expects from the sync endpoint.
    const res: AnchorCreateSessionResponse = {
      data: {
        id: asyncResolved.sessionId!,
        cdp_url: asyncResolved.cdpUrl ?? '',
        live_view_url: asyncResolved.liveViewUrl ?? '',
      },
    } as AnchorCreateSessionResponse;
    const insertResult = await pool.query(
      `INSERT INTO web_sessions
         (tenant_id, agent_id, thread_id, caller_session_id, vendor, vendor_session_id, vendor_metadata)
       VALUES ($1, $2, $3, $4, 'anchor', $5, $6)
       RETURNING *`,
      [
        tenantId, agentId, threadId ?? null, callerSessionId, res.data.id,
        JSON.stringify({
          cdp_url: res.data.cdp_url,
          live_view_url: res.data.live_view_url,
          ...(vendorIdentityId ? { vendor_identity_id: vendorIdentityId } : {}),
        }),
      ],
    );
    // The reaper is armed for the earliest open session (reap-schedule.ts).
    armWebSessionReapFor(insertResult.rows[0]);
    // PR2: emit SESSION_CREATED so dashboard streams pick up the new session
    // immediately (both internal-driven and RPC-driven creates share this path).
    try {
      const { emitBrowserSessionEvent } = await import('../../browser-sessions/events');
      const row = insertResult.rows[0] as Record<string, unknown>;
      emitBrowserSessionEvent({
        type: 'SESSION_CREATED',
        session: {
          id: row.id as string,
          tenantId: row.tenant_id as string,
          agentId: row.agent_id as string,
          threadId: (row.thread_id ?? null) as string | null,
          invocationId: (row.invocation_id ?? null) as string | null,
          vendor: row.vendor as string,
          vendorSessionId: row.vendor_session_id as string,
          liveViewUrl: res.data.live_view_url,
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
        },
        emittedAt: new Date(),
      });
    } catch (e) {
      logger.warn('failed to emit SESSION_CREATED', { error: (e as Error).message });
    }
    return { cdpUrl: res.data.cdp_url, liveViewUrl: res.data.live_view_url, isNew: true };
  }

  // PR2: public wrapper so handleWebTask's orphan cleanup can resolve
  // the vendor_session_id without reaching into the private method.
  public async lookupVendorSessionIdPublic(
    callerSessionId: string,
    tenantId: string,
  ): Promise<string | undefined> {
    return this.lookupVendorSessionId(callerSessionId, tenantId);
  }

  /** The endpoint takeover capture attaches to. Anchor hands the CDP URL
   *  back once, at session creation, and every spawn path here records it in
   *  the row's vendor_metadata (ensureSession reads the same field back), so
   *  the row is the source and there is no vendor call to fall back to. */
  public async cdpEndpointFor(vendorSessionId: string, _tenantId: string, _opts?: { fresh?: boolean }): Promise<string> {
    const stored = await storedCdpUrl(vendorSessionId);
    if (!stored) {
      throw new AnchorError(`anchor session ${vendorSessionId} has no recorded cdp_url`, 410);
    }
    return stored;
  }

  // PR2: Anchor in-session agent control endpoints. These hit
  // /v1/sessions/{id}/agent/{pause|resume|respond-to-human-intervention}.
  // 400 from pause/resume = "no agent running" — idempotent no-op.
  public async pauseAgent(vendorSessionId: string, tenantId: string): Promise<void> {
    try {
      await this.callJson(`/v1/sessions/${vendorSessionId}/agent/pause`, undefined, 'POST', tenantId, ANY_CONNECTOR);
    } catch (e) {
      if (e instanceof AnchorError && e.statusCode === 400) return;
      throw e;
    }
  }

  public async resumeAgent(vendorSessionId: string, tenantId: string): Promise<void> {
    try {
      await this.callJson(`/v1/sessions/${vendorSessionId}/agent/resume`, undefined, 'POST', tenantId, ANY_CONNECTOR);
    } catch (e) {
      if (e instanceof AnchorError && e.statusCode === 400) return;
      throw e;
    }
  }

  public async respondToIntervention(
    vendorSessionId: string, tenantId: string, requestId: string, response: string,
  ): Promise<void> {
    await this.callJson(
      `/v1/sessions/${vendorSessionId}/agent/respond-to-human-intervention`,
      { requestId, response },
      'POST',
      tenantId,
      ANY_CONNECTOR,
    );
  }

  /** Poll whether the in-session Anchor agent is currently waiting for
   *  a human-intervention response. Idempotent + cheap, intended as the
   *  poll-side backstop for the anchor-webhook flow when an inbound
   *  event is delayed / lost (Cloud Run cold-start drops, redeploys
   *  during the wait window, etc.). Returns null when no intervention
   *  is pending. */
  public async getRequestedHumanIntervention(
    vendorSessionId: string,
    tenantId: string,
  ): Promise<null | { requestId: string; question: string | null; requestedAt: string | null }> {
    const res = await this.callJson<{ data?: unknown } | null>(
      `/v1/sessions/${vendorSessionId}/agent/requested-human-intervention`,
      undefined,
      'GET',
      tenantId,
      ANY_CONNECTOR,
    );
    const data = (res && typeof res === 'object' ? (res as { data?: unknown }).data : null) ?? null;
    if (!data || typeof data !== 'object') return null;
    const obj = data as Record<string, unknown>;
    const requestId = typeof obj.request_id === 'string'
      ? obj.request_id
      : typeof obj.id === 'string' ? obj.id : null;
    if (!requestId) return null;
    return {
      requestId,
      question: typeof obj.question === 'string' ? obj.question
              : typeof obj.message === 'string' ? obj.message
              : null,
      requestedAt: typeof obj.requested_at === 'string' ? obj.requested_at
                  : typeof obj.created_at === 'string' ? obj.created_at
                  : null,
    };
  }

  /** GET /v1/sessions/{id} — session details: status, credits_used,
   *  duration, steps, tags, configuration. Lets the agent honestly
   *  answer "how much have we spent on this session", "how many steps
   *  has the in-session agent taken" without us having to compose it
   *  from local DB rows. */
  public async getSessionDetails(
    vendorSessionId: string,
    tenantId: string,
  ): Promise<{
    sessionId: string | null;
    status: string | null;
    creditsUsed: number | null;
    durationSec: number | null;
    steps: number | null;
    proxyBytes: number | null;
    tags: string[];
    createdAt: string | null;
    playground: boolean;
    configuration: Record<string, unknown> | null;
  }> {
    const res = await this.callJson<{ data?: Record<string, unknown> } | null>(
      `/v1/sessions/${vendorSessionId}`,
      undefined,
      'GET',
      tenantId,
      ANY_CONNECTOR,
    );
    const d = (res && typeof res === 'object' ? res.data : null) ?? {};
    const tagsRaw = (d as { tags?: unknown }).tags;
    const tags: string[] = Array.isArray(tagsRaw)
      ? tagsRaw.filter((t): t is string => typeof t === 'string')
      : [];
    const num = (v: unknown): number | null => typeof v === 'number' ? v : null;
    const str = (v: unknown): string | null => typeof v === 'string' ? v : null;
    return {
      sessionId: str((d as Record<string, unknown>).session_id) ?? str((d as Record<string, unknown>).id),
      status: str((d as Record<string, unknown>).status),
      creditsUsed: num((d as Record<string, unknown>).credits_used)
                 ?? num((d as Record<string, unknown>).used_credits),
      durationSec: num((d as Record<string, unknown>).duration),
      steps: num((d as Record<string, unknown>).steps),
      proxyBytes: num((d as Record<string, unknown>).proxy_bytes),
      tags,
      createdAt: str((d as Record<string, unknown>).created_at),
      playground: (d as Record<string, unknown>).playground === true,
      configuration: (d as Record<string, unknown>).configuration as Record<string, unknown> | null ?? null,
    };
  }

  /** Take a screenshot via Anchor's richer /v1/tools/screenshot endpoint
   *  rather than the basic /v1/sessions/{id}/screenshot — supports
   *  full-page capture (capture_full_height), scroll-and-stitch
   *  (scroll_all_content), explicit viewport (width/height), JS-wait
   *  (wait), and image_quality. The session-scoped /screenshot only
   *  captures the current viewport at the current scroll.
   *
   *  Returns the PNG (or JPEG, depending on image_quality) bytes.
   *  Caller decides what to do with them — embed via mcpContent, upload
   *  through the generated-files pipeline, etc. */
  public async fetchToolsScreenshot(
    vendorSessionId: string,
    tenantId: string,
    options: {
      width?: number;
      height?: number;
      /** 1-100; 100 is lossless. */
      imageQuality?: number;
      /** Wait ms after the page has loaded — for JS animations. */
      waitMs?: number;
      /** Scrolls the page and captures all visible content (multiple frames stitched). */
      scrollAllContent?: boolean;
      /** Captures the ENTIRE scrollable height, ignoring viewport height. */
      captureFullHeight?: boolean;
    } = {},
  ): Promise<Buffer> {
    const body: Record<string, unknown> = {};
    if (options.width !== undefined) body.width = options.width;
    if (options.height !== undefined) body.height = options.height;
    if (options.imageQuality !== undefined) body.image_quality = options.imageQuality;
    if (options.waitMs !== undefined) body.wait = options.waitMs;
    if (options.scrollAllContent !== undefined) body.scroll_all_content = options.scrollAllContent;
    if (options.captureFullHeight !== undefined) body.capture_full_height = options.captureFullHeight;
    const cred = await this.credential(tenantId, ANY_CONNECTOR);
    let res: Response;
    try {
      res = await fetch(
        `${ANCHOR_BASE_URL}/v1/tools/screenshot?sessionId=${encodeURIComponent(vendorSessionId)}`,
        {
          method: 'POST',
          headers: { 'anchor-api-key': cred.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
        },
      );
    } catch (e) {
      throw new AnchorError(`Network: ${(e as Error).message}`, 0);
    }
    if (!res.ok) throw await this.classifyAndThrow(res, tenantId, cred);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Non-blocking session create. Returns a request_id immediately
   *  while Anchor provisions the pod in the background. Use
   *  `pollAsyncSessionStatus(request_id)` until status === 'ready' to
   *  get the resolved session_id / cdp_url / live_view_url.
   *
   *  Letting the chat-turn-handler kick this off in parallel with the
   *  rest of its planning work (prompt build, catalog build, etc.)
   *  amortizes the 3-10s spawn over work that was already going to
   *  happen. Useful for the "fresh thread → first turn requests
   *  browser" path where the user otherwise sees a long pause before
   *  the pane shows up. */
  public async createSessionAsync(
    tenantId: string,
    body: {
      session?: { initial_url?: string; tags?: string[] };
      browser?: Record<string, unknown>;
      integrations?: Array<{ id: string; type: string; configuration?: Record<string, unknown> }>;
      identities?: Array<{ id: string }>;
    },
    scope: CredentialScope,
  ): Promise<{ requestId: string; status: string }> {
    const res = await this.callJson<{ data?: { request_id?: string; status?: string } }>(
      `/v1/sessions/async`,
      body,
      'POST',
      tenantId,
      scope,
    );
    const requestId = res?.data?.request_id;
    if (!requestId) throw new AnchorError('createSessionAsync: missing request_id in response', 500);
    return { requestId, status: res?.data?.status ?? 'pending' };
  }

  /** Poll for an async session-create's resolution. status === 'ready'
   *  means session_id / cdp_url / live_view_url are now populated; any
   *  other value means keep polling (typically 'pending' or 'provisioning'). */
  public async pollAsyncSessionStatus(
    tenantId: string,
    requestId: string,
    scope: CredentialScope,
  ): Promise<{
    status: string;
    sessionId: string | null;
    cdpUrl: string | null;
    liveViewUrl: string | null;
  }> {
    const res = await this.callJson<{ data?: Record<string, unknown> } | null>(
      `/v1/sessions/async/${requestId}/status`,
      undefined,
      'GET',
      tenantId,
      scope,
    );
    const d = res?.data ?? {};
    return {
      status: typeof d.status === 'string' ? d.status : 'unknown',
      sessionId: typeof d.session_id === 'string' ? d.session_id : null,
      cdpUrl: typeof d.cdp_url === 'string' ? d.cdp_url : null,
      liveViewUrl: typeof d.live_view_url === 'string' ? d.live_view_url : null,
    };
  }

  public async gotoUrl(vendorSessionId: string, tenantId: string, url: string): Promise<void> {
    await this.callJson(
      `/v1/sessions/${vendorSessionId}/goto`,
      { url },
      'POST',
      tenantId,
      ANY_CONNECTOR,
    );
  }

  public async getActivePage(
    vendorSessionId: string,
    tenantId: string,
  ): Promise<{ url: string | null; title: string | null; status: string }> {
    // Anchor's /active-page endpoint now returns a Playwright Page-handle stub
    // `{_type: 'Page', _guid: '...'}` instead of a URL string (pageKeys:
    // ['_type','_guid']). Their docs still claim `data.page` is a
    // string but the live API doesn't honour that. Switch to /pages which
    // returns an array of {id, title, url, frontend_url} per session tab —
    // the canonical "what's the browser showing right now" surface.
    const res = await this.callJson<unknown>(
      `/v1/sessions/${vendorSessionId}/pages`,
      undefined,
      'GET',
      tenantId,
      ANY_CONNECTOR,
    );
    // Anchor wraps most responses in { data: ... } but the docs describe /pages
    // as a bare array. Accept both so we're resilient to either shape.
    const rawPages = Array.isArray(res)
      ? res
      : (res as { data?: unknown } | null)?.data;
    const pages = Array.isArray(rawPages) ? rawPages : [];
    if (pages.length === 0) {
      // Session is alive but no page has been opened/navigated yet.
      return { url: null, title: null, status: 'no_pages' };
    }
    // For interactive (pane-driven) sessions there's exactly one page, which
    // is what the live-view iframe is bound to via the page hash in
    // live_view_url. Take the first entry.
    const first = pages[0] as { id?: unknown; title?: unknown; url?: unknown };
    return {
      url: typeof first.url === 'string' ? first.url : null,
      title: typeof first.title === 'string' ? first.title : null,
      status: 'ok',
    };
  }

  public async fetchScreenshotPng(vendorSessionId: string, tenantId: string): Promise<Buffer> {
    // Anchor returns image/png binary; callJson is JSON-only so we use a
    // shaped-once-here block that reuses the same classify-and-throw helper
    // we extract from callJson below.
    const cred = await this.credential(tenantId, ANY_CONNECTOR);
    let res: Response;
    try {
      res = await fetch(`${ANCHOR_BASE_URL}/v1/sessions/${vendorSessionId}/screenshot`, {
        method: 'GET',
        headers: { 'anchor-api-key': cred.apiKey },
        signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
      });
    } catch (e) {
      throw new AnchorError(`Network: ${(e as Error).message}`, 0);
    }
    if (!res.ok) throw await this.classifyAndThrow(res, tenantId, cred);
    return Buffer.from(await res.arrayBuffer());
  }

  public async runAgentTask(
    vendorSessionId: string,
    tenantId: string,
    prompt: string,
    attribution?: import('../../browser-sessions/session-vendor-proxy').TaskAttribution,
  ): Promise<{ status: string; result?: unknown; data?: unknown }> {
    // The one entry for every vendor (browser-task.ts): the Jev loop over
    // this session's own cdp_url; Anchor's in-session agent is the tail, and
    // today's path with the loop off. The agent call itself is untouched.
    const { runBrowserTask } = await import('./browser-task');
    // A session with no recorded cdp_url cannot host the loop; the entry then
    // goes straight to the tail, which is today's path.
    const cdpUrl = await this.cdpEndpointFor(vendorSessionId, tenantId).catch(() => undefined);
    return runBrowserTask({
      vendor: 'anchor',
      vendorSessionId,
      cdpUrl,
      prompt,
      tenantId,
      ...attribution,
      // The composed brief, not the bare objective: a tail that never heard
      // the constraints is a tail that will break them.
      runAnchorAgent: (_clock, brief) => this.runInSessionAgent(vendorSessionId, tenantId, brief),
    });
  }

  /** Anchor's own in-session agent (`/agent/run`), an opaque vendor LLM loop. */
  public async runInSessionAgent(
    vendorSessionId: string,
    tenantId: string,
    prompt: string,
  ): Promise<{ status: string; result?: unknown; data?: unknown }> {
    return this.callJson(
      `/v1/sessions/${vendorSessionId}/agent/run`,
      { prompt, human_intervention: true },
      'POST',
      tenantId,
      ANY_CONNECTOR,
    );
  }

  /** Fetch the rendered DOM of the page CURRENTLY OPEN in this session as
   *  markdown or HTML. Anchor's /v1/tools/fetch-webpage, with sessionId
   *  passed in the query string and `url` omitted from the body, targets
   *  the session's active page (per Anchor docs:
   *    "When left empty, the current webpage is used").
   *  Markdown is the right default for the model — it preserves headings,
   *  links, lists and code while costing a small fraction of the tokens
   *  a base64 PNG screenshot would consume, and the model can quote text
   *  back accurately. Reserve the screenshot path for genuinely visual
   *  questions ("does this look right", "is the button red"). */
  public async fetchActivePageContent(
    vendorSessionId: string,
    tenantId: string,
    options: { format?: 'markdown' | 'html'; waitMs?: number; returnPartialOnTimeout?: boolean } = {},
  ): Promise<string> {
    const format = options.format ?? 'markdown';
    const body: Record<string, unknown> = { format };
    if (options.waitMs !== undefined) body.wait = options.waitMs;
    if (options.returnPartialOnTimeout !== undefined) body.return_partial_on_timeout = options.returnPartialOnTimeout;
    const res = await this.callJson<string | { content?: string }>(
      `/v1/tools/fetch-webpage?sessionId=${encodeURIComponent(vendorSessionId)}`,
      body,
      'POST',
      tenantId,
      ANY_CONNECTOR,
    );
    // Anchor's docs example shows a bare string response, but their JSON
    // envelopes elsewhere wrap it as { content }. Accept either so a
    // server-side response-shape tweak doesn't blow up read_active_browser_session.
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && typeof res.content === 'string') return res.content;
    return '';
  }

  /** Render the page CURRENTLY OPEN in this session as a PDF and return
   *  the binary bytes. Anchor's /v1/tools/page-pdf with sessionId in the
   *  query string and `url` omitted from the body targets the session's
   *  active page. Common asks: "save this article as PDF", "send me a
   *  copy of the receipt I just got", "archive this terms page". */
  public async fetchActivePagePdf(
    vendorSessionId: string,
    tenantId: string,
    options: {
      landscape?: boolean;
      displayHeaderFooter?: boolean;
      printBackground?: boolean;
      scale?: number;
      paperWidth?: number;
      paperHeight?: number;
      marginTop?: number;
      marginBottom?: number;
      marginLeft?: number;
      marginRight?: number;
      pageRanges?: string;
      headerTemplate?: string;
      footerTemplate?: string;
      preferCSSPageSize?: boolean;
    } = {},
  ): Promise<Buffer> {
    const cred = await this.credential(tenantId, ANY_CONNECTOR);
    let res: Response;
    try {
      res = await fetch(
        `${ANCHOR_BASE_URL}/v1/tools/page-pdf?sessionId=${encodeURIComponent(vendorSessionId)}`,
        {
          method: 'POST',
          headers: { 'anchor-api-key': cred.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(options),
          signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
        },
      );
    } catch (e) {
      throw new AnchorError(`Network: ${(e as Error).message}`, 0);
    }
    if (!res.ok) throw await this.classifyAndThrow(res, tenantId, cred);
    return Buffer.from(await res.arrayBuffer());
  }

  /** List the files the user (or Anchor's in-session agent) downloaded
   *  during this session. Without this, anything the browser produces
   *  (an invoice PDF clicked from a "Download" button, a generated
   *  export, a saved attachment) is invisible to the orchestrating
   *  agent — the user sees the file in their downloads pane but the
   *  agent has no idea it exists. */
  public async listSessionDownloads(
    vendorSessionId: string,
    tenantId: string,
  ): Promise<Array<{
    id: string;
    fileLink: string;
    originalDownloadUrl: string | null;
    originUrl: string | null;
    suggestedFileName: string;
    originalFileName: string | null;
    durationMs: number | null;
    sizeBytes: number | null;
    createdAt: string;
  }>> {
    const res = await this.callJson<{ data?: { items?: unknown[]; count?: number } }>(
      `/v1/sessions/${vendorSessionId}/downloads`,
      undefined,
      'GET',
      tenantId,
      ANY_CONNECTOR,
    );
    const items = Array.isArray(res?.data?.items) ? res!.data!.items! : [];
    return items.map((raw) => {
      const it = raw as Record<string, unknown>;
      return {
        id: String(it.id ?? ''),
        fileLink: String(it.file_link ?? ''),
        originalDownloadUrl: typeof it.original_download_url === 'string' ? it.original_download_url : null,
        originUrl: typeof it.origin_url === 'string' ? it.origin_url : null,
        suggestedFileName: String(it.suggested_file_name ?? it.original_file_name ?? ''),
        originalFileName: typeof it.original_file_name === 'string' ? it.original_file_name : null,
        durationMs: typeof it.duration === 'number' ? it.duration : null,
        sizeBytes: typeof it.size === 'number' ? it.size : null,
        createdAt: String(it.created_at ?? ''),
      };
    });
  }

  /** Fetch the actual bytes of a downloaded file by Anchor's file-link
   *  URL. The link returned by listSessionDownloads requires the same
   *  api-key header, so this helper authenticates the request. */
  public async fetchDownloadBytes(fileLink: string, tenantId: string): Promise<Buffer> {
    const cred = await this.credential(tenantId, ANY_CONNECTOR);
    let res: Response;
    try {
      res = await fetch(fileLink, {
        method: 'GET',
        headers: { 'anchor-api-key': cred.apiKey },
        signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
      });
    } catch (e) {
      throw new AnchorError(`Network: ${(e as Error).message}`, 0);
    }
    if (!res.ok) throw await this.classifyAndThrow(res, tenantId, cred);
    return Buffer.from(await res.arrayBuffer());
  }

  /** List Anchor's video recordings of this session. The primary
   *  recording (`is_primary: true`) is the canonical full-session video;
   *  secondary recordings are per-tab. Useful for audit / replay and
   *  for "show me what the agent did" type requests. */
  public async listSessionRecordings(
    vendorSessionId: string,
    tenantId: string,
  ): Promise<Array<{
    id: string;
    isPrimary: boolean;
    fileLink: string;
    suggestedFileName: string | null;
    duration: string | null;
    sizeBytes: number | null;
    createdAt: string | null;
  }>> {
    const res = await this.callJson<{ data?: { items?: unknown[]; count?: number } }>(
      `/v1/sessions/${vendorSessionId}/recordings`,
      undefined,
      'GET',
      tenantId,
      ANY_CONNECTOR,
    );
    const items = Array.isArray(res?.data?.items) ? res!.data!.items! : [];
    return items.map((raw) => {
      const it = raw as Record<string, unknown>;
      return {
        id: String(it.id ?? ''),
        isPrimary: it.is_primary === true,
        fileLink: String(it.file_link ?? ''),
        suggestedFileName: typeof it.suggested_file_name === 'string' ? it.suggested_file_name : null,
        duration: typeof it.duration === 'string' ? it.duration : null,
        sizeBytes: typeof it.size === 'number' ? it.size : null,
        createdAt: typeof it.created_at === 'string' ? it.created_at : null,
      };
    });
  }

  protected async callJson<T>(
    path: string,
    body: unknown,
    method: 'GET' | 'POST' = 'POST',
    tenantId: string,
    scope: CredentialScope,
  ): Promise<T> {
    const cred = await this.credential(tenantId, scope);
    let res: Response;
    try {
      res = await fetch(`${ANCHOR_BASE_URL}${path}`, {
        method,
        headers: { 'anchor-api-key': cred.apiKey, 'Content-Type': 'application/json' },
        ...(method === 'POST' && body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
      });
    } catch (e) {
      throw new AnchorError(`Network: ${(e as Error).message}`, 0);
    }
    if (!res.ok) throw await this.classifyAndThrow(res, tenantId, cred);
    return await res.json() as T;
  }

  // Shared BYOK error classification path. Extracted from callJson so the
  // binary screenshot fetch can reuse it.
  private async classifyAndThrow(
    res: Response,
    tenantId: string,
    cred: WebToolCredential,
  ): Promise<never> {
    // Anchor's error body is { error: { code, message } } (occasionally
    // { error: "string" } or { message: "string" }). The old code assumed
    // `error` was always a string, so an object body rendered as "[object
    // Object]" and hid the real reason. Extract the human message, falling back
    // to the raw JSON so a 500 is never opaque.
    let body: unknown;
    try { body = await res.json(); } catch { /* response body not JSON */ }
    const errField = (body as { error?: unknown; message?: string } | undefined)?.error;
    const message =
      (typeof errField === 'string' ? errField : undefined)
      ?? (errField as { message?: string } | undefined)?.message
      ?? (body as { message?: string } | undefined)?.message
      ?? (body !== undefined ? JSON.stringify(body) : res.statusText);
    const aErr = new AnchorError(`Anchor ${res.status}: ${message}`, res.status, body);
    const classified = this.classifyVendorError(aErr);
    // Read the limit headers and, on a 429, set this key aside so the next
    // request takes the tenant's next key rather than the one that just asked
    // us to stop. The insufficient_funds / invalid_key cooldowns are applied by
    // markConnectorErrored below, so this does not double-count them.
    observeVendorResponse({
      tenantId, vendor: 'anchor_browser', connectorId: cred.connectorId,
      status: res.status, headers: res.headers,
    });
    if (classified === 'insufficient_funds' || classified === 'invalid_key') {
      await markConnectorErrored(tenantId, 'anchor_browser', cred.connectorId, classified, aErr.message);
      throw new BYOKVendorError(
        classified, 'anchor_browser', tenantId, cred.connectorId,
        buildByokErrorMessage('anchor_browser', classified),
      );
    }
    throw aErr;
  }

  // ── Exact-cost capture for identity_create / profile_save ──────────────
  private billingMeasurementMutex: Promise<unknown> = Promise.resolve();

  private async withBillingMutex<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.billingMeasurementMutex;
    let releaseHere: () => void = () => {};
    this.billingMeasurementMutex = new Promise<void>(r => { releaseHere = r; });
    try { await previous; } catch { /* prev errored; we still proceed */ }
    try { return await fn(); }
    finally { releaseHere(); }
  }

  protected async fetchCreditsUsed(tenantId: string): Promise<number> {
    const body = await this.callJson<AnchorBillingResponse>('/v1/billing', undefined, 'GET', tenantId, ANY_CONNECTOR);
    // Live API returns credits_used flat; older/mocked shapes nested it under
    // `data`. Read flat first, fall back to `data`.
    const used = body?.credits_used ?? body?.data?.credits_used;
    if (typeof used !== 'number' || used < 0) {
      throw new AnchorError(
        `Anchor /v1/billing response missing credits_used (cannot capture exact cost)`,
        422,
      );
    }
    return used;
  }

  private async measureExactCreditDelta<T>(
    tenantId: string,
    op: () => Promise<T>,
  ): Promise<{ result: T; costMicros: number }> {
    return this.withBillingMutex(async () => {
      const before = await this.fetchCreditsUsed(tenantId);
      const result = await op();
      const after = await this.fetchCreditsUsed(tenantId);
      const delta = Math.max(0, after - before);
      return {
        result,
        costMicros: Math.round(delta * ANCHOR_USD_PER_CREDIT * 1_000_000),
      };
    });
  }

  // /v1/tools/fetch-webpage returns text/plain, not a JSON envelope.
  private async callText(path: string, body: unknown, tenantId: string, scope: CredentialScope): Promise<string> {
    const cred = await this.credential(tenantId, scope);
    const res = await fetch(`${ANCHOR_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'anchor-api-key': cred.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
    });
    if (!res.ok) {
      let err: { error?: string; message?: string } | undefined;
      try { err = await res.json() as { error?: string; message?: string }; } catch { /* response body not JSON */ }
      const aErr = new AnchorError(
        `Anchor ${res.status}: ${err?.error ?? err?.message ?? res.statusText}`,
        res.status, err,
      );
      const classified = this.classifyVendorError(aErr);
      if (classified === 'insufficient_funds' || classified === 'invalid_key') {
        await markConnectorErrored(
          tenantId, 'anchor_browser', cred.connectorId, classified, aErr.message,
        );
        throw new BYOKVendorError(
          classified, 'anchor_browser', tenantId, cred.connectorId,
          buildByokErrorMessage('anchor_browser', classified),
        );
      }
      throw aErr;
    }
    return await res.text();
  }
}

// ── PR2: oversight-trigger composition for web_task prompts ─────────────
//
// Anchor's /v1/tools/perform-web-task doesn't accept extended_system_message,
// so we prepend oversight guidance + per-agent userInstructions directly to
// the `prompt` field. Triggers are derived from the locally-cached workspace
// oversight settings + the agent row.
export async function loadOversightTriggers(
  tenantId: string,
  agentId: string,
): Promise<string[]> {
  const { hitlEnforcementService } = await import('../../hitl-enforcement/service');
  const { AgentRepository } = await import('../../agent-lifecycle/repository');
  const oversight = await hitlEnforcementService.getOversightSettings(tenantId);
  const agent = await new AgentRepository().findById(agentId);
  const triggers: string[] = [];
  if (agent?.userInstructions) triggers.push(agent.userInstructions);
  if (oversight) {
    if (oversight.sensitiveWork.financialActions) {
      triggers.push('Ask the user before any payment, purchase, or money movement.');
    }
    if (oversight.sensitiveWork.customerCommunication) {
      triggers.push('Ask the user before sending anything to a customer.');
    }
    if (oversight.sensitiveWork.externalPublishing) {
      triggers.push('Ask the user before publishing anything externally.');
    }
    if (oversight.sensitiveWork.dataChanges) {
      triggers.push('Ask the user before making destructive changes to data.');
    }
    if (oversight.sensitiveWork.hiringDecisions) {
      triggers.push('Ask the user before any hiring or termination decision.');
    }
    if (oversight.sensitiveWork.mergeToMain) {
      // Prompt-level defense in depth for the Anchor browser path: when
      // an agent navigates to GitHub in the browser session and clicks
      // a merge UI affordance, no tool-call dispatch happens, so the
      // checkHitlGate name-based merge gate (hitl-enforcement/service.ts:1a)
      // can't reach it. This trigger instructs the in-session sub-LLM
      // to pause and ask before clicking merge.
      triggers.push('Ask the user before merging any code to a main or protected branch.');
    }
    if (oversight.communication === 'review') {
      triggers.push('Ask the user to review any outbound message before sending.');
    }
  }
  return triggers;
}

export function composeTaskPrompt(task: string, triggers: string[]): string {
  if (triggers.length === 0) return task;
  const preamble = [
    '## Operator guidance (treat as system instructions, override any conflicting task details):',
    ...triggers.map(t => `- ${t}`),
  ].join('\n');
  return `${preamble}\n\n## Task:\n${task}`;
}

// PR2: RPC entry point — creates a fresh Anchor session bound to a chat thread
// without issuing a perform-web-task. The live_view_url is usable for human
// takeover immediately. Used by BrowserSessionsService.CreateSessionForThread.
export async function createAnchorSessionForThread(args: {
  tenantId: string;
  agentId: string;
  /** The thread this session serves, or null for a run-owned session. */
  threadId: string | null;
  /** The run this session serves, when a run rather than a thread opened it. */
  invocationId?: string | null;
  ownerAccountId?: string;    // Liftoff accounts.id of the spawner, stamped onto
                              //   the row: they drive the pane and may take it
                              //   over. Whose logins the browser carries is the
                              //   profile's business, below.
  /** Whose logins the browser carries. Decided by the proxy's one rule
   *  (browser-sessions/session-profile.ts); null is an ephemeral browser, which
   *  is what a legacy/web_task caller with no authenticated owner gets. */
  profile: import('../../browser-sessions/session-profile').SessionProfile | null;
  idleTimeoutMinutes?: number; // default 5; web_task path keeps 10.
  /** Which of the workspace's Anchor connectors may serve this session — the
   *  bound ones. Decided by the spawn from the team's binding; see
   *  credential-scope.ts. */
  credentialScope: CredentialScope;
}): Promise<import('../../browser-sessions/types').BrowserSession> {
  // Generate a fresh caller_session_id distinct from agent-loop ones to avoid
  // colliding with the UNIQUE(tenant_id, agent_id, caller_session_id) constraint.
  const callerSessionId = `ui:${randomUUID()}`;
  // Replicate just enough of ensureSession to stay self-contained — we don't
  // want to invoke perform-web-task; just create the Anchor session, insert
  // the row, emit the event.
  const cred = await getWebToolCredential(args.tenantId, 'anchor_browser', args.credentialScope);
  if (!cred) throw new AnchorError('no anchor credential for tenant', 0);
  // The profile is handed in, named by the one rule every vendor shares. No
  // profile means a fresh (non-persisted) browser.
  // HEADED (not headless): these sessions back the interactive browser pane —
  // live view, goto, and screenshot (page-state) all rely on Anchor's VNC
  // operations, which Anchor rejects in headless sessions with
  // "VNC operations not supported in headless sessions" (HTTP 500). This is the
  // pane surface, not the autonomous perform-web-task path, so headed is correct.
  const ownerProfileName = args.profile?.name ?? null;
  const browser: Record<string, unknown> = {
    adblock: { active: true },
    captcha_solver: { active: true },
    headless: { active: false },
    extra_stealth: { active: true },
  };
  if (ownerProfileName) {
    browser.profile = { name: ownerProfileName, persist: true };
  }
  let res: Response;
  try {
    res = await fetch(`${ANCHOR_BASE_URL}/v1/sessions`, {
      method: 'POST',
      headers: { 'anchor-api-key': cred.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser,
        session: {
          timeout: {
            max_duration: 60,
            idle_timeout: args.idleTimeoutMinutes ?? 5,
          },
        },
      }),
      signal: AbortSignal.timeout(ANCHOR_TIMEOUT_MS),
    });
  } catch (e) {
    throw new AnchorError(`Network: ${(e as Error).message}`, 0);
  }
  if (!res.ok) throw new AnchorError(`Anchor ${res.status}: ${res.statusText}`, res.status);
  const body = await res.json() as AnchorCreateSessionResponse;
  const pool = getPool();
  const insertResult = await pool.query(
    `INSERT INTO web_sessions (
       tenant_id, agent_id, thread_id, invocation_id, owner_account_id, caller_session_id,
       vendor, vendor_session_id, vendor_metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, 'anchor', $7, $8)
     RETURNING *`,
    [
      args.tenantId, args.agentId, args.threadId, args.invocationId ?? null,
      args.ownerAccountId ?? null, callerSessionId,
      body.data.id,
      JSON.stringify({
        cdp_url: body.data.cdp_url,
        live_view_url: body.data.live_view_url,
      }),
    ],
  );
  // The reaper is armed for the earliest open session (reap-schedule.ts).
  armWebSessionReapFor(insertResult.rows[0]);
  const row = insertResult.rows[0] as Record<string, unknown>;
  // Record the deterministic pane profile so a login the user completes in the
  // live-view pane is listable/forgettable via web_session_list /
  // web_session_forget. Done AFTER the session create succeeds so a failed
  // spawn never leaves an orphan profile row. profile_kind='pane': this is one
  // browser per (tenant,agent,owner) that may hold many site logins — distinct
  // from a deliberate, per-site, sticky-IP 'saved' profile. vendor_profile_id =
  // the name (Anchor's reuse key). No sticky IP and no last_used_at on create.
  if (args.profile) {
    await pool.query(
      `INSERT INTO web_profiles (tenant_id, profile_name, vendor, vendor_profile_id, owner_account_id, agent_id, profile_kind)
       VALUES ($1, $2, 'anchor', $2, $3, $4, $5)
       ON CONFLICT (tenant_id, profile_name)
       DO UPDATE SET vendor           = EXCLUDED.vendor,
                     vendor_profile_id = EXCLUDED.vendor_profile_id,
                     owner_account_id = EXCLUDED.owner_account_id,
                     agent_id         = EXCLUDED.agent_id,
                     profile_kind     = EXCLUDED.profile_kind,
                     updated_at       = now()`,
      [args.tenantId, args.profile.name, args.profile.ownerAccountId, args.agentId, args.profile.kind],
    );
  }
  const session: import('../../browser-sessions/types').BrowserSession = {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    agentId: row.agent_id as string,
    threadId: (row.thread_id ?? null) as string | null,
    invocationId: (row.invocation_id ?? null) as string | null,
    vendor: row.vendor as string,
    vendorSessionId: row.vendor_session_id as string,
    liveViewUrl: body.data.live_view_url,
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
  try {
    const { emitBrowserSessionEvent } = await import('../../browser-sessions/events');
    emitBrowserSessionEvent({ type: 'SESSION_CREATED', session, emittedAt: new Date() });
  } catch (e) {
    logger.warn('failed to emit SESSION_CREATED', { error: (e as Error).message });
  }
  return session;
}
