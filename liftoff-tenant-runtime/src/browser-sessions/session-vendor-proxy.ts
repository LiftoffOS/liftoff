// Vendor dispatch for the session/pane operations.
//
// Was anchor-proxy.ts, a thin facade over the Anchor singleton, back when
// Anchor was the only vendor that could own a thread's browser. Every function
// now takes the session's `vendor` and routes accordingly, so the RPC handlers
// in service.ts never name a vendor.
//
// Adding a session vendor means adding one entry to VENDOR_OPS. A vendor that
// reaches here without an entry is a programming error, not a user-facing
// failure, so it throws rather than silently no-opping — a browser that
// accepted `goto` and did nothing would look like a hung page.

import { anchorClient, browserUseClient, browserbaseClient, steelClient } from '../tools/standard-tool-handler';
import type { BrowserTaskTrail } from '../integrations/web-fetch/step-policy';
import {
  browserUseClient as buStatsClient, browserbaseClient as bbStatsClient, steelClient as stStatsClient,
} from '../tools/standard-tool-handler';
// Anchor prices in credits; this is the published USD rate, mirrored from
// anchor-client.ts so the stats block reports money rather than a unit only
// Anchor understands.
const ANCHOR_USD_PER_CREDIT = 0.10;

/** The operations the pane needs from whatever vendor owns a session.
 *
 *  pauseAgent/resumeAgent are about the VENDOR's own in-session agent, not our
 *  takeover state. Anchor runs one and it has to be stopped before a human
 *  takes the wheel; Browser Use does not, so its implementations are no-ops and
 *  `takeover_state` alone gates our loop. Both are correct for their vendor. */
export interface SessionVendorOps {
  pauseAgent(vendorSessionId: string, tenantId: string): Promise<void>;
  resumeAgent(vendorSessionId: string, tenantId: string): Promise<void>;
  gotoUrl(vendorSessionId: string, tenantId: string, url: string): Promise<void>;
  getActivePage(vendorSessionId: string, tenantId: string): Promise<{ url: string; title?: string }>;
  fetchScreenshotPng(vendorSessionId: string, tenantId: string): Promise<Buffer>;
  fetchActivePageContent(vendorSessionId: string, tenantId: string): Promise<string>;
  /** `captureFullHeight` is the only portable option. The rest are Anchor's
   *  screenshot endpoint (scroll behaviour, explicit dimensions, quality, an
   *  extra settle delay); a vendor that renders through Playwright ignores them
   *  and still returns a correct screenshot, which is better than rejecting the
   *  call over a knob that does not apply. */
  fetchToolsScreenshot(
    vendorSessionId: string,
    tenantId: string,
    opts?: {
      captureFullHeight?: boolean; scrollAllContent?: boolean;
      width?: number; height?: number; imageQuality?: number; waitMs?: number;
    },
  ): Promise<Buffer>;
  fetchActivePagePdf(vendorSessionId: string, tenantId: string): Promise<Buffer>;
  closeSession(vendorSessionId: string, tenantId: string): Promise<void>;
  /** Hand a multi-step instruction to the VENDOR's own in-session agent, which
   *  drives the session the person is watching.
   *
   *  Both vendors run one. Anchor answers synchronously; Browser Use creates a
   *  task against the session and polls it. The difference is inside the
   *  clients, and the shape here is the same, so no caller branches on vendor. */
  runAgentTask(
    vendorSessionId: string,
    tenantId: string,
    prompt: string,
    attribution?: TaskAttribution,
  ): Promise<{ status: string; result?: unknown; data?: unknown; trail?: BrowserTaskTrail }>;
  /** The live session's CDP endpoint, for the pooled connection every pane
   *  operation shares and for takeover capture. Our stored one first, the
   *  vendor's on a miss, or the vendor's outright when `fresh` is set because
   *  the stored one did not connect. Throws when the session is not live. */
  cdpEndpointFor(vendorSessionId: string, tenantId: string, opts?: { fresh?: boolean }): Promise<string>;
}

/** Whose spend a task's own model calls are: the run they happen in, when
 *  there is one. Without it the agent loop's tokens fall to the managed key
 *  with no usage row to the run's name. */
export interface TaskAttribution {
  invocationId?: string;
  runtimeAgentId?: string;
  /** The run's model selection, for the Stagehand tail (change 3): the
   *  provider it resolves to at tier medium decides the credential and the
   *  AI SDK model. Absent for a platform assistant: the platform default. */
  modelSelection?: import('../llm/types').ModelSelection;
  /** Values the assistant passed as parameters: literals the Jev loop may
   *  type (jev-loop/literals.ts). */
  parameters?: Record<string, unknown>;
  /** Let a long task outlive the call that started it. Set for a caller with
   *  a conversation to come back to; a headless task has nowhere to report
   *  and nothing to come back for. */
  background?: boolean;
  /** What finishing looks like, in the caller's words. */
  success?: string;
  /** What the task may not do, beyond the workspace's own settings. */
  constraints?: string[];
}

function opsFor(vendor: string): SessionVendorOps {
  switch (vendor) {
    case 'anchor':      return anchorClient as unknown as SessionVendorOps;
    case 'browserbase': return browserbaseClient as unknown as SessionVendorOps;
    case 'steel':       return steelClient as unknown as SessionVendorOps;
    case 'browser_use': return browserUseClient as unknown as SessionVendorOps;
    default:
      throw new Error(
        `browser session vendor '${vendor}' has no pane operations registered ` +
        `(add it to VENDOR_OPS in session-vendor-proxy.ts)`,
      );
  }
}

export async function pauseAgent(vendor: string, vendorSessionId: string, tenantId: string): Promise<void> {
  return opsFor(vendor).pauseAgent(vendorSessionId, tenantId);
}

export async function resumeAgent(vendor: string, vendorSessionId: string, tenantId: string): Promise<void> {
  return opsFor(vendor).resumeAgent(vendorSessionId, tenantId);
}

export async function gotoUrl(vendor: string, vendorSessionId: string, tenantId: string, url: string): Promise<void> {
  await opsFor(vendor).gotoUrl(vendorSessionId, tenantId, url);
  // The page the runtime just moved may be a sign-in page: the saved-login
  // fill (integrations/onepassword) runs here, awaited, on every vendor,
  // so the caller's next read sees the signed-in page. Every navigation
  // the runtime makes on a session lands here: the pane's, the session
  // start's initial URL, web_task's starting URL. A workspace without the
  // connector pays one cached lookup.
  const { applySavedLoginAfterNavigation } = await import('../integrations/onepassword/autofill');
  await applySavedLoginAfterNavigation(vendor, vendorSessionId, tenantId);
}

export async function getActivePage(vendor: string, vendorSessionId: string, tenantId: string) {
  return opsFor(vendor).getActivePage(vendorSessionId, tenantId);
}

export async function fetchScreenshotPng(vendor: string, vendorSessionId: string, tenantId: string): Promise<Buffer> {
  return opsFor(vendor).fetchScreenshotPng(vendorSessionId, tenantId);
}

/** Stopping a session is NOT one of the pane operations, and it dispatches on a
 *  wider list than opsFor.
 *
 *  It is kept separate from opsFor because the two lists answer different
 *  questions. A vendor can hold a session without being able to DRIVE the pane
 *  — browserbase was exactly that until it grew the other nine operations — and
 *  a historical row for such a vendor still has to be closable. Routing a close
 *  through opsFor would refuse the one operation such a vendor can perform, and
 *  a session nobody can stop keeps its charge and its concurrency slot until
 *  the vendor's own timeout.
 *
 *  Unknown vendors still throw. A close that silently did nothing would leave a
 *  row marked closed and a browser running, which is the leak this exists to
 *  prevent. */
function closerFor(vendor: string): Pick<SessionVendorOps, 'closeSession'> {
  switch (vendor) {
    case 'anchor':      return anchorClient as unknown as SessionVendorOps;
    case 'browser_use': return browserUseClient as unknown as SessionVendorOps;
    case 'browserbase': return browserbaseClient as unknown as SessionVendorOps;
    case 'steel':       return steelClient as unknown as SessionVendorOps;
    default:
      throw new Error(
        `browser session vendor '${vendor}' cannot be closed ` +
        `(add it to closerFor in session-vendor-proxy.ts)`,
      );
  }
}

export async function closeSession(vendor: string, vendorSessionId: string, tenantId: string): Promise<void> {
  // The pooled connection, and the recorder attached on it, go before the
  // vendor is told, whichever path is closing: the disconnect is then ours,
  // not an observation lost. Reached dynamically for the import order's sake
  // (cdp-page imports this module for the endpoint lookup).
  const { dropConnection } = await import('./cdp-page');
  await dropConnection(vendor, vendorSessionId).catch(() => undefined);
  return closerFor(vendor).closeSession(vendorSessionId, tenantId);
}

// Anchor-only. Intervention (a CAPTCHA or login prompt raised by Anchor's own
// in-session agent) is a concept the other vendors do not have: nothing on the
// vendor side is asking us a question. Left on the Anchor client directly so
// the shape of that asymmetry stays visible rather than being flattened into
// an interface method that only one vendor can implement.
export async function respondToIntervention(
  vendorSessionId: string,
  tenantId: string,
  requestId: string,
  response: string,
): Promise<void> {
  return anchorClient.respondToIntervention(vendorSessionId, tenantId, requestId, response);
}

/** What a person or an agent asked "how is this session going" wants back, in
 *  one shape for every vendor.
 *
 *  The three report different things — Anchor counts credits and agent steps,
 *  Browser Use settles browser time against proxy egress, Browserbase gives
 *  timestamps — so this is the intersection that means the same thing
 *  everywhere, plus whatever else the vendor volunteered.
 *
 *  It exists because get_browser_session_stats was Anchor-gated and stayed that
 *  way after the other two grew a getSessionDetails of their own. The agent was
 *  told a capability did not exist while the client sitting behind it
 *  implemented exactly that call, which is worse than a missing tool: it is a
 *  refusal a person will believe. */
export interface SessionStats {
  status: string;
  costUsd: number;
  startedAt: string | null;
  finishedAt: string | null;
  proxyMb: number;
  /** Vendor-specific extras, present only where the vendor reports them. */
  details: Record<string, unknown>;
}

export async function getSessionStats(
  vendor: string,
  vendorSessionId: string,
  tenantId: string,
): Promise<SessionStats> {
  switch (vendor) {
    case 'anchor': {
      const d = await anchorClient.getSessionDetails(vendorSessionId, tenantId);
      return {
        status: d.status ?? 'unknown',
        // Anchor prices in credits, so USD is the only figure comparable with
        // the other two. The credit count stays in details for anyone
        // reconciling against an Anchor invoice.
        costUsd: (d.creditsUsed ?? 0) * ANCHOR_USD_PER_CREDIT,
        startedAt: d.createdAt,
        finishedAt: null,
        proxyMb: (d.proxyBytes ?? 0) / 1_048_576,
        details: { creditsUsed: d.creditsUsed, durationSec: d.durationSec, steps: d.steps, tags: d.tags },
      };
    }
    case 'browserbase': {
      const d = await bbStatsClient.getSessionDetails(vendorSessionId, tenantId);
      return { ...d, startedAt: d.startedAt, details: {} };
    }
    case 'browser_use': {
      const d = await buStatsClient.getSessionDetails(vendorSessionId, tenantId);
      return { ...d, startedAt: d.startedAt, details: {} };
    }
    case 'steel': {
      const d = await stStatsClient.getSessionDetails(vendorSessionId, tenantId);
      return { ...d, startedAt: d.startedAt, details: {} };
    }
    default:
      // Deliberately throws. A zeroed stat block would read as "this session has
      // cost nothing and done nothing", which is a statement, not an absence.
      throw new Error(`cannot read session statistics for vendor '${vendor}'`);
  }
}

export async function runAgentTask(
  vendor: string,
  vendorSessionId: string,
  tenantId: string,
  prompt: string,
  attribution?: TaskAttribution,
) {
  return opsFor(vendor).runAgentTask(vendorSessionId, tenantId, prompt, attribution);
}

export async function cdpEndpointFor(
  vendor: string, vendorSessionId: string, tenantId: string, opts?: { fresh?: boolean },
): Promise<string> {
  return opsFor(vendor).cdpEndpointFor(vendorSessionId, tenantId, opts);
}

// ── Session creation: which vendor gets to own a thread's browser ──────────

import { getTenantConnectedWebVendors, type WebToolVendor } from '../integrations/web-fetch/web-tool-secrets';
import { usableWebVendors, type WebVendorScope } from '../integrations/web-fetch/vendor-scope';
import { scopeFor, type CredentialScope } from '../integrations/web-fetch/credential-scope';
import { BROWSER_VENDOR_ORDER, CONNECTOR_TYPE_OF } from '../integrations/web-fetch/vendor-order';
import type { WebVendor } from '../integrations/web-fetch/types';
import { platformPaneVendor, isPlatformPaneVendor, markPlatformPaneVendorRefused } from './session-vendor-connectors';
// Re-exported so existing importers keep working; DEFINED in the leaf module
// so a consumer that only needs to recognise the error does not inherit the
// vendor clients this file imports.
import { NoSessionVendorConnected, SessionVendorAtCapacity } from './session-errors';
export { NoSessionVendorConnected, SessionVendorAtCapacity } from './session-errors';
import { createAnchorSessionForThread } from '../integrations/web-fetch/anchor-client';
import { createBrowserUseSessionForThread } from '../integrations/web-fetch/browser-use-client';
import { createBrowserbaseSessionForThread } from '../integrations/web-fetch/browserbase-client';
import { createSteelSessionForThread } from '../integrations/web-fetch/steel-client';
import { PlatformBrowserUnavailable } from '../integrations/web-fetch/browser-use-client';
import { NO_AGENT_SENTINEL, type BrowserSession } from './types';
import { logger } from '../infrastructure/logging';
import { profileFor } from './session-profile';

/** Preference order when a tenant has connected more than one, highest first.
 *
 *  This is a CAPABILITY preference, not a cost ordering, and it is deliberately
 *  the opposite principle from the fetch/extract chains in web-fetch/router.ts:
 *  those are cost-tiered and put browserbase AHEAD of anchor. Do not "reconcile"
 *  the two — a browser promoted out of its cost tier bills every tenant more for
 *  pages that never needed one.
 *
 *  browserbase sat OUT of this list for a long time, and the reason is worth
 *  keeping: it declared supportsSessions() true while implementing only
 *  fetch/extract/closeSession, so listing it would have handed a thread to a
 *  vendor that could not drive the pane. It implements the full set now, and
 *  takes the slot that was reserved for it. */
const SESSION_VENDOR_PREFERENCE: ReadonlyArray<{ vendor: WebVendor; connector: WebToolVendor }> =
  // The one browser order, shared with the JS fetch chain (vendor-order.ts):
  // Anchor > Browserbase > Steel > Browser Use, each paired with its connector.
  BROWSER_VENDOR_ORDER.map((vendor) => ({ vendor, connector: CONNECTOR_TYPE_OF[vendor] as WebToolVendor }));

/** The vendor that owns a thread's browser when the workspace connected
 *  nothing is decided by platformPaneVendor: the platform holds a key for
 *  Steel and for Browser Use, and the first of those that is switched on and
 *  configured serves, so a browser is a default rather than something a
 *  workspace has to buy first.
 *
 *  That tier sits BELOW every entry in SESSION_VENDOR_PREFERENCE, and the
 *  ordering is the charging rule made structural: a workspace that connected
 *  its own key has already paid the vendor for these hours, so its connector
 *  must win or we bill it a second time for a browser it is funding itself. */
const PLATFORM_SESSION_VENDORS: ReadonlySet<WebVendor> = new Set<WebVendor>(['steel', 'browser_use']);

/** Every pane vendor's spawns are checked against its plan's concurrent-browser
 *  ceiling before dispatch.
 *
 *  It matters most on the platform key, where every workspace in this runtime
 *  draws from ONE vendor plan (Steel's Launch plan holds ten browsers) and
 *  nothing local counted what the plan was holding. But it was never only a platform problem: a pane session takes no
 *  slot in the web-fetch admission pool, so for EVERY vendor the ceiling was
 *  enforced by nothing until the vendor started refusing. Reaching a vendor's
 *  limit is a retryable "every browser is in use", and finding that out from a
 *  429 mid-spawn is strictly worse than knowing it before asking. */
const CAPACITY_CHECKED_VENDORS = new Set<WebVendor>([
  'anchor', 'browserbase', ...PLATFORM_SESSION_VENDORS,
]);

/** Resolve the vendor a NEW thread session should use.
 *
 *  BOTH halves matter, and getting this wrong is what put an Anchor session on
 *  an agent distilled for Browser Use: the tenant must have the connector
 *  ACTIVE (the credential has to exist) AND the agent must be BOUND to it.
 *  Checking only the tenant meant a workspace that happens to have Anchor
 *  connected handed every agent an Anchor browser, silently overriding what the
 *  agent was actually equipped with — and the preference order made Anchor win
 *  every time.
 *
 *  This is the same bound-AND-connected rule expose-tools applies with
 *  byokAgent(); the two disagreeing is precisely how an agent ends up holding a
 *  session whose tools it was never given.
 *
 *  When nothing the WORKSPACE brought satisfies both, the platform's own key
 *  (Steel, else Browser Use) backs the session instead, so an agent has a
 *  browser without anyone connecting anything. Returns null only when that
 *  tier is switched off too, which today means an operator has pulled every
 *  platform vendor's kill-switch. */
export async function selectSessionVendor(
  tenantId: string,
  agentId?: string,
  /** The tenant's connected web vendors, when the caller already has them.
   *  createSessionForThread does, and this is an uncached cross-service call. */
  prefetchedConnected?: Set<WebToolVendor>,
): Promise<WebVendor | null> {
  return (await resolveSessionVendor(tenantId, agentId, prefetchedConnected)).vendor;
}

/** selectSessionVendor with the scope it decided from, so the spawn can hand
 *  the bound connector ids to the credential resolver (credential-scope.ts):
 *  choosing the vendor by the binding and then taking any of the workspace's
 *  keys for it would be the same defect one layer down. */
async function resolveSessionVendor(
  tenantId: string,
  agentId: string | undefined,
  prefetchedConnected?: Set<WebToolVendor>,
): Promise<{ vendor: WebVendor | null; scope: WebVendorScope }> {
  // vendor-scope.ts answers bound-AND-connected in one place for the session
  // picker and the fetch/research chains alike, id-space translation
  // included. A caller with no agent (the platform assistants' pane) gets the
  // connected set: the workspace acting as itself.
  const [scope, platformVendor] = await Promise.all([
    usableWebVendors(tenantId, agentId, prefetchedConnected),
    platformPaneVendor(tenantId),
  ]);
  const own = SESSION_VENDOR_PREFERENCE.find((v) => scope.vendors.has(v.connector))?.vendor;
  if (own) return { vendor: own, scope };
  // Nothing the workspace brought can drive a pane, so the platform key does.
  // The bound-AND-connected rule above still governs the workspace's OWN
  // vendors and is untouched: it decides which connector wins, not whether a
  // browser exists at all. Binding cannot gate this tier for the same reason it
  // does not gate web_research — a platform-backed capability is not something
  // the agent was equipped with, it is something the product has.
  return { vendor: platformVendor, scope };
}

/** A vendor's plan caps how many browsers may be open AT ONCE, and a pane
 *  session holds one of those slots for its whole life.
 *
 *  The web-fetch admission pool cannot express that. It is built for in-flight
 *  REQUESTS: a slot is taken, the call returns, the slot is released, and the
 *  row expires after five minutes if the process dies. A pane session outlives
 *  all of that, and is released by a different process minutes later. So pane
 *  spawns took no slot at all, and the plan's ceiling was enforced by nothing
 *  until the vendor started answering 429.
 *
 *  The open rows ARE the count: one live `web_sessions` row is one browser the
 *  vendor is holding for us. Expired-but-unreaped rows are excluded because the
 *  vendor has already timed those out and freed the slot on its side.
 *
 *  The SCOPE follows the funding, which is the whole point:
 *    - a workspace on its OWN key gets its own account's ceiling, so a busy
 *      neighbour cannot spend its slots
 *    - on the PLATFORM key every workspace in this runtime shares one account,
 *      so the count has to span tenants or ten workspaces would each believe
 *      they had ten browsers
 *
 *  It cannot see OTHER runtimes, and does not pretend to. A dedicated runtime
 *  has its own database, so the authoritative ceiling for the platform key
 *  stays the vendor's own 429 — which the Steel and Browser Use clients
 *  classify as retryable rather than letting it surface as a generic failure. This check is
 *  what stops one runtime walking into that on its own.
 *
 *  Anchor and Browserbase are BYOK-only, so their scope is always the
 *  workspace's own account and the shared-account problem cannot arise there.
 *  They are still checked, because the ceiling is real on any plan and a
 *  refusal we can explain beats a vendor 429 mid-spawn. */
async function assertSessionSlotAvailable(
  vendor: WebVendor,
  connector: WebToolVendor,
  tenantId: string,
  connected: Set<WebToolVendor>,
): Promise<void> {
  const { getVendorConcurrencyLimits } = await import('../integrations/web-fetch/limits-config');
  const { getPool } = await import('../infrastructure/database');
  const limits = await getVendorConcurrencyLimits(vendor);
  const ceiling = limits.maxConcurrentGlobal;
  if (!Number.isFinite(ceiling) || ceiling <= 0) return;

  const tenantFunded = connected.has(connector);
  const { rows } = await getPool().query<{ n: string }>(
    tenantFunded
      ? `SELECT COUNT(*) AS n FROM web_sessions
          WHERE vendor = $1 AND closed_at IS NULL AND expires_at > now()
            AND tenant_id = $2`
      : `SELECT COUNT(*) AS n FROM web_sessions
          WHERE vendor = $1 AND closed_at IS NULL AND expires_at > now()`,
    tenantFunded ? [vendor, tenantId] : [vendor],
  );
  const open = parseInt(rows[0]?.n ?? '0', 10);
  if (open >= ceiling) {
    throw new SessionVendorAtCapacity(vendor, open, ceiling);
  }
}

/** What a caller hands the spawn. The credential scope is NOT among them: it
 *  is decided here, from the team's binding, next to the vendor choice it
 *  belongs to, and the factories refuse a call without one. */
type SpawnArgs = Omit<Parameters<typeof createSteelSessionForThread>[0], 'credentialScope'>;

function spawnWith(vendor: WebVendor, spawnArgs: SpawnArgs, credentialScope: CredentialScope): Promise<BrowserSession> {
  const args = { ...spawnArgs, credentialScope };
  switch (vendor) {
    case 'anchor':      return createAnchorSessionForThread(args);
    case 'browserbase': return createBrowserbaseSessionForThread(args);
    case 'steel':       return createSteelSessionForThread(args);
    case 'browser_use': return createBrowserUseSessionForThread(args);
    default:            throw new NoSessionVendorConnected();
  }
}

/** Select, check the slot, spawn, and on a PLATFORM vendor's refusal do it
 *  once more without that vendor.
 *
 *  The platform tier holds more than one key on purpose, and the second is
 *  worth nothing if a refusal on the first ends the spawn. A workspace's own
 *  connector never falls through here: its key failing is the workspace's
 *  account to fix, and moving it onto our key would hide that and start
 *  charging it for a browser it is paying for (the rule browser-use-client's
 *  resolver states). So the fallback applies only when the vendor came from
 *  the platform tier, which is exactly when the workspace connected nothing
 *  that could serve. */
async function selectAndSpawn(
  tenantId: string,
  agentForSelection: string | undefined,
  connected: Set<WebToolVendor>,
  spawnArgs: SpawnArgs,
): Promise<BrowserSession> {
  for (let attempt = 0; ; attempt++) {
    const { vendor, scope } = await resolveSessionVendor(tenantId, agentForSelection, connected);
    if (!vendor) throw new NoSessionVendorConnected();
    const connector = SESSION_VENDOR_PREFERENCE.find((v) => v.vendor === vendor)?.connector;
    if (connector && CAPACITY_CHECKED_VENDORS.has(vendor)) {
      await assertSessionSlotAvailable(vendor, connector, tenantId, connected);
    }
    try {
      // The vendor was chosen by the binding; its key must be too. A vendor
      // the team is not bound to (the platform tier) gets NO workspace
      // connector, so a workspace Steel or Browser Use the team was never
      // given is not what the platform-key session quietly runs on.
      const credentialScope = connector ? scopeFor(scope, connector) : { connectorIds: null };
      return await spawnWith(vendor, spawnArgs, credentialScope);
    } catch (err) {
      const platformTier = isPlatformPaneVendor(vendor) && !(connector && connected.has(connector));
      if (!(err instanceof PlatformBrowserUnavailable) || !platformTier || attempt > 0) throw err;
      markPlatformPaneVendorRefused(vendor, err.retryable);
      logger.warn(
        { tenantId, vendor, code: err.code, retryable: err.retryable, event: 'platform_pane_vendor_refused' },
        'platform browser vendor refused the spawn; trying the next platform vendor',
      );
    }
  }
}

/**
 * Close the scope's own session when its time is already up, before a new
 * one is opened for it.
 *
 * A scope holds exactly ONE open row: `web_sessions_one_active_per_thread`
 * and `web_sessions_one_active_per_invocation` are partial unique indexes on
 * `closed_at IS NULL`. The reaper closes an expired row minutes later, and
 * until it does, the vendor has released the browser but the row is still
 * there — so the spawn would insert a second open row for the scope and the
 * database would refuse it. Reaping the dead one here is what lets the new
 * one exist, and it hands the vendor its browser back at the same time.
 *
 * Never throws: a scope with nothing expired is the ordinary case, and a
 * teardown that fails still closes the row (see closeExpiredSession), which
 * is what the spawn needs.
 */
async function reapExpiredForScope(
  tenantId: string,
  scope: { threadId?: string | null; invocationId?: string | null },
): Promise<void> {
  const { getPool } = await import('../infrastructure/database');
  const by = scope.invocationId
    ? { column: 'invocation_id', value: scope.invocationId }
    : { column: 'thread_id', value: scope.threadId };
  if (!by.value) return;
  try {
    const { rows } = await getPool().query(
      `SELECT id, tenant_id, vendor, vendor_session_id FROM web_sessions
       WHERE tenant_id = $1 AND ${by.column} = $2 AND closed_at IS NULL AND expires_at < now()`,
      [tenantId, by.value],
    );
    if (rows.length === 0) return;
    const { closeExpiredSession } = await import('../integrations/web-fetch/session-reaper');
    for (const row of rows) {
      const result = await closeExpiredSession(row);
      logger.info(
        { tenant_id: tenantId, session_id: row.id, vendor: row.vendor, outcome: result.outcome, event: 'session_reaped_before_spawn' },
        'the scope\'s session had expired; it was closed so a new one can open',
      );
    }
  } catch (err) {
    logger.warn(
      { tenant_id: tenantId, err: (err as Error).message, event: 'session_reap_before_spawn_failed' },
      'could not close the expired session before spawning; the spawn may collide with it',
    );
  }
}

/** Create a thread-bound browser session with whichever vendor wins the
 *  preference. Callers never name a vendor; that decision lives here so the
 *  pane, the tools and the RPC handlers cannot drift apart on it. */
export async function createSessionForThread(args: {
  tenantId: string;
  /** Absent for a platform assistant, which has no agent row anywhere.
   *
   *  Three spellings arrive here and all mean the same thing: undefined from a
   *  caller inside this process, '' from a Connect-RPC caller (proto3's default
   *  for a string), and NO_AGENT_SENTINEL from one that already normalized.
   *  They are reconciled below rather than at the eight call sites, because a
   *  rule applied per-caller is a rule that will be applied at seven of them. */
  agentId?: string;
  /** Which platform assistant opened this, when no agent did: 'liftoff',
   *  'insights' or 'team_plan'. Absent for a team agent, which `agentId`
   *  identifies. Recorded because the three otherwise share one identity — the
   *  no-agent sentinel — and their spend would be indistinguishable. */
  assistant?: string;
  threadId: string;
  ownerAccountId?: string;
  idleTimeoutMinutes?: number;
  /** The pane's size when it opened, so the browser is created at the size
   *  the person sees. Steel takes it on the create; every vendor gets one
   *  setViewportSize after the row is written (service.ts). */
  viewport?: { width: number; height: number };
}): Promise<BrowserSession> {
  // The thread's own session, when its time is up: closed here so this spawn
  // has a row to occupy (one open row per thread) and the vendor has its
  // browser back.
  await reapExpiredForScope(args.tenantId, { threadId: args.threadId });
  // ONE connector lookup for both decisions. selectSessionVendor needs it to
  // pick the vendor and the slot check needs it to know whose ceiling applies,
  // and it is an uncached cross-service call, so asking twice per spawn was a
  // round trip bought for nothing.
  const connected = await getTenantConnectedWebVendors(args.tenantId);
  // web_sessions.agent_id is UUID NOT NULL, so "no agent" has to be written as
  // something. An empty string is not a UUID: it reaches Postgres as `invalid
  // input syntax for type uuid: ""` and the spawn dies, which is exactly what
  // happened to every platform-assistant session until this line existed.
  const callerAgentId = args.agentId || NO_AGENT_SENTINEL;
  // TRANSLATE FIRST, as boundWebVendorConnectors does. The pane's ensure RPC
  // carries the control-plane internal_agents.id straight from the frontend;
  // a chat turn's tool call carries the runtime agents.id. Everything below
  // is keyed by the agent — the profile that holds the team's logins, the
  // web_sessions row the takeover gate matches on — and one key with two
  // spellings is two keys: a login the person completes in the pane lands in
  // one profile while every run and chat turn opens another, signed in as
  // nobody. The runtime id is the one this database keys on, and
  // resolveRuntimeAgentId hands a runtime id back unchanged.
  const agentId = callerAgentId === NO_AGENT_SENTINEL
    ? callerAgentId
    : await (await import('../agent-lifecycle/resolve-runtime-agent-id'))
      .resolveRuntimeAgentId(args.tenantId, callerAgentId, 'createSessionForThread');
  // Whose logins this browser carries, decided once for every vendor: the
  // team's own profile for a team agent, the assistant's workspace profile for
  // a platform assistant.
  const profile = profileFor({
    tenantId: args.tenantId, agentId, assistant: args.assistant, ownerAccountId: args.ownerAccountId,
  });
  const spawnArgs = { ...args, agentId, profile };
  // Selection is the other half and must NOT see the sentinel: it would go
  // looking for that agent's bindings, find none, and log a mapping miss that
  // never happened. Undefined is the honest input — "no opinion about
  // connectors" — and is what keeps the workspace's OWN vendor winning when it
  // has one, so a workspace paying for a browser is not billed twice.
  const agentForSelection = agentId === NO_AGENT_SENTINEL ? undefined : agentId;
  const session = await selectAndSpawn(args.tenantId, agentForSelection, connected, spawnArgs);

  // Stamped HERE rather than in each vendor's INSERT. Three clients write their
  // own row, and a field added to two of the three is the kind of gap that only
  // shows up later as one assistant's spend quietly missing from reporting.
  //
  // Merged into vendor_metadata rather than given a column: it is JSONB and
  // already on the row, so this needs no migration, and a failure to label must
  // never fail the spawn — the browser is open and working either way.
  if (args.assistant) {
    const { getPool } = await import('../infrastructure/database');
    await getPool().query(
      `UPDATE web_sessions SET vendor_metadata = vendor_metadata || $2::jsonb WHERE id = $1`,
      [session.id, JSON.stringify({ assistant: args.assistant })],
    ).catch((err: Error) => logger.warn(
      { err: err.message, session_id: session.id, assistant: args.assistant },
      'could not label the session with its assistant; its cost will report as unattributed',
    ));
  }
  return session;
}

/**
 * Open the one browser a RUN may own.
 *
 * A scheduled or delegated run has no thread and no person, and a browser
 * session has been a thread's — opened under the profile of the person on
 * it. A run's session is keyed by its invocation instead, one live session per
 * run, closed when the run ends (closeActiveForInvocation, from the run's
 * completion) and by the idle reaper as the net. It binds the TEAM's profile:
 * a run is always a team's, and the logins a person put in that profile
 * through the team's pane are what the run is signed in as.
 *
 * Same vendor selection, capacity check and cost recording as a pane session.
 */
export async function createSessionForRun(args: {
  tenantId: string;
  agentId: string;
  invocationId: string;
  idleTimeoutMinutes?: number;
}): Promise<BrowserSession> {
  if (!args.agentId || args.agentId === NO_AGENT_SENTINEL) {
    throw new Error('a run-owned browser session needs the team that runs it');
  }
  await reapExpiredForScope(args.tenantId, { invocationId: args.invocationId });
  const connected = await getTenantConnectedWebVendors(args.tenantId);
  const spawnArgs = {
    tenantId: args.tenantId,
    agentId: args.agentId,
    threadId: null,
    invocationId: args.invocationId,
    profile: profileFor({ tenantId: args.tenantId, agentId: args.agentId }),
    idleTimeoutMinutes: args.idleTimeoutMinutes,
  };
  return selectAndSpawn(args.tenantId, args.agentId, connected, spawnArgs);
}

/**
 * Close the run's browser, if it has one. Called from the run's completion,
 * whatever the outcome: a paused run's segment has ended too, and the next
 * segment opens its own session under the same profile. Never throws — the
 * run's result is already decided, and the reaper closes what this could not.
 */
export async function closeActiveForInvocation(tenantId: string, invocationId: string): Promise<void> {
  const { getActiveForInvocation, closeSession: closeSessionRow, endTakeoverHoldForClose } = await import('./repository');
  // includeExpired: this path's job is to finish the session off, and a run
  // that outlived its browser still has a row to close and a cost to settle.
  const session = await getActiveForInvocation(tenantId, invocationId, { includeExpired: true });
  if (!session) return;
  try {
    // The hold ends before the browser is stopped (see endTakeoverHoldForClose),
    // and the pooled connection goes before the vendor is told.
    await endTakeoverHoldForClose(session.id);
    const { dropConnection } = await import('./cdp-page');
    await dropConnection(session.vendor, session.vendorSessionId).catch(() => undefined);
    await closeSession(session.vendor, session.vendorSessionId, tenantId);
    await closeSessionRow(session.id, 'run_ended');
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, session_id: session.id, invocation_id: invocationId, vendor: session.vendor },
      'run-owned browser session could not be closed at run end; the reaper will',
    );
  }
}

// ── Profiles: the persistent logins behind "stay signed in" ────────────────

import {
  browserUseClient as buClient, browserbaseClient as bbClient, steelClient as stClient,
} from '../tools/standard-tool-handler';

export interface StoredProfile {
  name: string;
  /** The vendor's own handle. Anchor keys profiles by NAME, Browser Use and
   *  Steel by id, so this column holds different things per vendor by design. */
  vendorProfileId: string;
  /** Origins this profile holds cookies for, when the vendor reports them.
   *  Browser Use does; Anchor does not, so it stays null there. */
  cookieDomains?: string[] | null;
}

/** Profiles the vendor still actually holds, used as the liveness cross-check
 *  behind web_session_list. A local row is only a reusable login if the vendor
 *  still has the profile. */
export async function listProfiles(vendor: string, tenantId: string): Promise<StoredProfile[]> {
  switch (vendor) {
    case 'anchor': {
      const ps = await anchorClient.listProfiles(tenantId);
      // Anchor's reuse key IS the name, so it is also the vendor handle.
      return ps.map((p) => ({ name: p.name, vendorProfileId: p.name, cookieDomains: null }));
    }
    case 'browserbase':
      return bbClient.listProfiles(tenantId);
    case 'browser_use':
      return buClient.listProfiles(tenantId);
    case 'steel':
      return stClient.listProfiles(tenantId);
    default:
      // Deliberately throws rather than returning []. An empty list is
      // indistinguishable from "this vendor holds no profiles", and the caller
      // uses that to FILTER rows out — so returning [] for a vendor we simply
      // do not know how to ask would silently hide a person's saved logins.
      // Throwing makes the caller degrade open instead, which is the stated
      // contract of the liveness check.
      throw new Error(`cannot list profiles for vendor '${vendor}'`);
  }
}

/** Delete a stored login at the vendor. Idempotent on both vendors: a profile
 *  already gone counts as forgotten, since surfacing a 404 would strand a local
 *  row the person cannot clear. */
export async function deleteProfile(vendor: string, vendorProfileId: string, tenantId: string): Promise<void> {
  switch (vendor) {
    case 'anchor':      return anchorClient.deleteProfile(vendorProfileId, tenantId);
    case 'browserbase': return bbClient.deleteProfile(vendorProfileId, tenantId);
    case 'browser_use': return buClient.deleteProfile(vendorProfileId, tenantId);
    case 'steel':       return stClient.deleteProfile(vendorProfileId, tenantId);
    default:
      throw new Error(`cannot delete a profile for vendor '${vendor}'`);
  }
}

/** Vendors that can own a stored profile, for the SQL filters in
 *  web_session_list / web_session_forget. Kept here so the query and the
 *  dispatch cannot drift: a row the query returns but the dispatch cannot
 *  handle would be a login the person can see and never forget. */
export const PROFILE_VENDORS: readonly string[] = ['anchor', 'browserbase', 'steel', 'browser_use'];

// ── Tool-facing operations ────────────────────────────────────────────────
//
// These mirror the pane operations above but are called from the STANDARD TOOL
// handlers rather than the RPC layer. They were the half missed when the pane
// was made vendor-aware: browser-sessions/service.ts routed through the proxy
// while standard-tool-handler.ts kept calling the Anchor client directly, so an
// agent on a Browser Use session had a working pane and every tool pointed at
// the wrong vendor with a session id Anchor has never heard of.

export async function fetchActivePageContent(vendor: string, vendorSessionId: string, tenantId: string): Promise<string> {
  return opsFor(vendor).fetchActivePageContent(vendorSessionId, tenantId);
}

export async function fetchToolsScreenshot(
  vendor: string, vendorSessionId: string, tenantId: string,
  opts?: Parameters<SessionVendorOps['fetchToolsScreenshot']>[2],
): Promise<Buffer> {
  return opsFor(vendor).fetchToolsScreenshot(vendorSessionId, tenantId, opts);
}

export async function fetchActivePagePdf(vendor: string, vendorSessionId: string, tenantId: string): Promise<Buffer> {
  return opsFor(vendor).fetchActivePagePdf(vendorSessionId, tenantId);
}

/** Whether a capability that only Anchor has is out of reach on this
 *  session's browser.
 *
 *  Two are left, and both are genuinely Anchor-shaped rather than merely
 *  unbuilt: waiting on an intervention its in-session agent raised, which the
 *  other browsers have no in-session agent to raise, and its hosted
 *  credential capture.
 *
 *  Two have LEFT that set, both for the same reason: they were in it because
 *  Anchor had an endpoint and the others did not, and they stayed after that
 *  stopped being the deciding fact, so a tool refused what its own session
 *  could do. Session statistics went when the other clients grew a
 *  session-detail endpoint (see getSessionStats above). Downloads went when
 *  they stopped being a vendor feature at all: a download is announced on the
 *  session's own CDP connection, which every vendor gives us, and the bytes
 *  are fetched from inside the page (browser-sessions/downloads.ts). Before
 *  that, "bring me the file I just downloaded" worked on one of the four
 *  browsers a session can run on, and the pane runs another by default. */
export function isAnchorOnly(vendor: string): boolean {
  return vendor !== 'anchor';
}
