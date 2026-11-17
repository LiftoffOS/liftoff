// Filter STANDARD_TOOLS to the web tools whose backends are available. Two
// tiers, because the web tools split into two kinds:
//
//   TIER 1 — NATIVE-BACKED (tenant-level). web_fetch_advanced, web_research,
//   web_people_search, web_finance_search, web_deep_research. These have a
//   platform-managed backend (Perplexity / OpenAI / Google), so they exist
//   for every agent by default — gated only on the vendor's global feature
//   flag (web_fetch_vendor_<vendor>, an operator kill-switch). A tenant-
//   connected BYOK vendor (Exa/Tavily/Firecrawl/WebClaw) only *adds a
//   backend* to these — it does not create or gate the tool — and it adds
//   that backend FOR THE TEAMS BOUND TO IT: the router (vendor-scope.ts)
//   routes an unbound team to the platform backends, so the offer here is
//   tenant-level and the account that serves a call is the team's own.
//
//   TIER 2 — BYOK-EXCLUSIVE (per-agent). web_extract, web_diff, and the
//   Anchor-shaped tools (web_task, web_identity_connect, web_session_save).
//   These have NO native backend, so they only exist when a BYOK vendor backs
//   them. For these, the tenant having the connector is necessary but NOT
//   sufficient: the *agent* must be bound to it (ctx.allowedConnectors). This
//   keeps a narrow agent from silently gaining browse/scrape powers just
//   because another agent in the tenant connected the vendor — capability
//   scoping lives in the binding.
//
//   The PANE tools (start_browser_session, navigate_browser_session,
//   run_browser_task, web_session_close/list/forget) left tier 2 when the
//   platform took a Browser Use key of its own. They now have a platform-
//   managed backend, which is the whole definition of tier 1, so they exist for
//   every agent and the gate is the kill-switch. A workspace that connects its
//   own browser connector still wins the vendor choice — see
//   SESSION_VENDOR_PREFERENCE — it just no longer decides whether a browser
//   exists at all.
//
// BYOK vendors have no kill-switch flag — connector state is authoritative.
// To globally disable one for incident response, an operator marks every
// tenant's connector of that type as errored (or revokes the IAM grant on
// connector-scoped Secret Manager paths).
//
// Used by createToolGatewayMcpServer (interactive) and buildToolsSchema in
// agent-execution/service.ts (autonomous) to build the per-session tool
// palette the LLM sees. Both pass ctx.allowedConnectors; callers that omit
// it (unit tests) fall back to tenant-level for tier 2 as well.

import { getAllVendorFlags } from './global-flags';
import { getTenantConnectedWebVendors, type WebToolVendor } from './web-tool-secrets';
import { platformPaneBrowserOn } from '../../browser-sessions/session-vendor-connectors';
import * as repo from '../../browser-sessions/repository';
import {
  skillDisclosureMode as resolveSkillDisclosureMode,
  type SkillDisclosureMode,
} from '../../skills/retrieval';

export interface MinimalToolDef { name: string }

export async function buildExposedStandardTools<T extends MinimalToolDef>(
  standardTools: readonly T[],
  tenantId: string,
  ctx: {
    threadId?: string;
    messageSenderAccountId?: string;
    /** When the caller already resolved the thread's session (e.g. the
     *  agent-execution turn prefetch), pass it here to skip the redundant
     *  getActiveForThread lookup. Falls back to a threadId query otherwise. */
    hasActiveBrowserSession?: boolean;
    /** The thread has browser activity or takeover holds recorded on it,
     *  session or none: what gates `read_browser_session_activity` beside
     *  an open session, so a person can ask what they did in a browser that
     *  has since closed. Computed once by the caller beside the session
     *  prefetch; undefined reads as false. */
    threadHasBrowserRecord?: boolean;
    /** Connector types/ids the *agent* is bound to (deriveAllowedConnectors of
     *  the compiled instruction's integrations). Governs the BYOK-EXCLUSIVE
     *  tools — those with no platform-native backend (web_extract, web_diff,
     *  and the Anchor browser/session tools). For those, the tenant having the
     *  connector is necessary but not sufficient: the agent must also be bound
     *  to it, so a narrow agent doesn't silently gain browser/scrape powers
     *  just because some *other* agent in the tenant connected the vendor.
     *
     *  Tools WITH a native backend (web_fetch_advanced / web_research /
     *  web_*_search / web_deep_research) are platform capabilities and stay
     *  tenant-level here — a BYOK vendor only upgrades their backend routing,
     *  and the router applies that upgrade to the bound team alone.
     *
     *  When undefined (e.g. unit tests, or a caller that hasn't wired it),
     *  per-agent gating is skipped and the legacy tenant-level behavior
     *  applies — never lose a tool because binding info wasn't threaded. */
    allowedConnectors?: string[];
    /** Per-invocation skill-disclosure override, service-auth only. Governs
     *  whether `read_skill` is exposed. Undefined means "use the deployment's
     *  mode", which is every product path. */
    skillDisclosureMode?: SkillDisclosureMode;
    /** Whether the run's engine attaches the model vendor's own hosted web
     *  search to the model's calls (adapter/native-web-search.ts). When it
     *  does, that IS the basic search and the bridged `web_search` is not
     *  offered, so a model never sees two things called web search. Undefined
     *  — a caller that knows no run — offers it rather than withholding a
     *  tool on a guess. */
    nativeWebSearch?: boolean;
    /** Which surface this catalog is for. The MODEL's list withholds the bridged
     *  `web_search` where the engine attaches the vendor's own, so a model never
     *  sees two things called web search. The RUN's list validates and dispatches
     *  deterministic steps and advises recovery; a step never calls the model and
     *  the vendor's search is attached only to the model's calls, so the run list
     *  offers it wherever a backend exists. Undefined behaves as 'model'. */
    surface?: 'model' | 'run';
    /** The provider the run resolved to. Decides which backend the bridged
     *  `web_search` needs to be on for the tool to be offered: xAI's for a
     *  Grok run (Perplexity as its fallback), Perplexity's otherwise. */
    provider?: string;
    /** A run with no thread — scheduled, triggered or delegated — and so no
     *  person to spawn a browser under. Such a run may own one browser session
     *  of its own, under the team's profile, so the spawning browser tools are
     *  offered to it on the same vendor condition a person's thread needs.
     *  Undefined or false is a thread. */
    autonomousRun?: boolean;
  } = {},
): Promise<T[]> {
  const [flags, connected] = await Promise.all([
    getAllVendorFlags(),
    getTenantConnectedWebVendors(tenantId),
  ]);
  // Through the shared helper even though the flag is already in hand, so this
  // gate and selectSessionVendor cannot answer the question differently. The
  // flags are handed over rather than re-read: they are an uncached database
  // row and this runs on every turn.
  const platformPaneOn = await platformPaneBrowserOn(tenantId, flags);

  // Helpers — a vendor is available when its global flag is on AND
  // (platform-managed OR tenant has connected the connector).
  const platform = (k: 'perplexity' | 'openai' | 'google' | 'xai' | 'locus_web' | 'locus_exa' | 'browserbase_x402') => flags[k];
  // A connector-backed vendor the platform also holds a pay-as-you-go key
  // for (PLATFORM_FUNDED_FALLBACK in vendor-order.ts): available on the flag
  // alone, like a platform-managed one, and served on the team's own account
  // when it is bound to one.
  const platformFunded = (v: 'tavily' | 'exa') => flags[v];
  // Tenant-level: the connector is connected somewhere in the tenant. Governs
  // native-backed tools' backend routing only.
  const byokTenant = (v: WebToolVendor) => connected.has(v);
  // Per-agent: the connector is connected AND this agent is bound to it.
  // When allowedConnectors is undefined, fall back to tenant-level (legacy).
  const boundSet = ctx.allowedConnectors ? new Set(ctx.allowedConnectors) : null;
  const byokAgent = (v: WebToolVendor) =>
    connected.has(v) && (boundSet === null || boundSet.has(v));

  // Native (platform-managed) backends — global flag only, no connector.
  const perplexityOn   = platform('perplexity');
  const openaiOn       = platform('openai');
  const googleOn       = platform('google');
  const xaiOn          = platform('xai');

  // fetch chain (NATIVE-backed → tenant-level): needs at least one backend
  // (perplexity covers the always-on case).
  //
  // steel and browser_use appear here as EITHER a connected connector or the
  // platform key, matching vendorAvailable() in router.ts. The two must agree:
  // this decides whether the tool is offered and that decides whether a
  // backend exists to serve it, so a narrower answer here withholds a fetch
  // tool the router could have satisfied.
  const anyBackend =
    perplexityOn || byokTenant('webclaw') || byokTenant('firecrawl') ||
    byokTenant('anchor_browser') || byokTenant('browserbase') ||
    platformFunded('tavily') || platformFunded('exa') || platform('locus_exa') ||
    platform('locus_web') || platform('browserbase_x402') ||
    byokTenant('steel') || byokTenant('browser_use') || platformPaneOn;
  // research chain (NATIVE-backed → tenant-level): any text-backed vendor,
  // the platform's pay-as-you-go Tavily and Exa included.
  const anyResearchBackend =
    perplexityOn || byokTenant('webclaw') || byokTenant('firecrawl') ||
    platformFunded('tavily') || platformFunded('exa') || platform('locus_exa');
  // The bridged basic search (NATIVE-backed → tenant-level), on the backend the
  // provider owns — xAI for a Grok run, with Perplexity behind it; Perplexity
  // for everyone else. The model's list gets it only where the engine attaches
  // no vendor search of its own; the run's list gets it wherever the backend
  // exists, because a deterministic step never calls the model and the
  // vendor's search is attached only to the model's calls. See
  // adapter/native-web-search.ts for the per-engine answer and router.search
  // for the backend order.
  const platformSearchOn = perplexityOn || platform('locus_web') || platform('browserbase_x402');
  const bridgedSearchBackend = ctx.provider === 'xai' ? (xaiOn || platformSearchOn) : platformSearchOn;
  const bridgedSearchOn =
    bridgedSearchBackend && (ctx.surface === 'run' || ctx.nativeWebSearch !== true);
  // deep_research chain (NATIVE-backed → tenant-level): perplexity, openai, google.
  const anyDeepResearchBackend = perplexityOn || openaiOn || googleOn;

  // extract chain (BYOK-EXCLUSIVE → per-agent): webclaw, firecrawl,
  // anchor_browser, browserbase only. No native backend (perplexity/exa/tavily
  // lack a schema-guided extraction primitive), so binding is the gate.
  // steel and browser_use are excluded for that same reason: each hands out a
  // browser and nothing else, with no schema-guided extraction endpoint to call.
  // The platform's pay-per-use extract (locus_web, Firecrawl through the
  // platform's Locus key) is the one native extract backend: it makes
  // web_extract a tool every agent has, with a team's
  // own bound account still tried first.
  const anyExtractBackend =
    platform('locus_web') ||
    byokAgent('webclaw') || byokAgent('firecrawl') ||
    byokAgent('anchor_browser') || byokAgent('browserbase');
  // web_diff (BYOK-EXCLUSIVE → per-agent): webclaw only.
  const webclawAgentOn = byokAgent('webclaw');
  // Anchor browser/session tools (BYOK-EXCLUSIVE → per-agent): anchor only.
  const anchorAgentOn  = byokAgent('anchor_browser');
  // Any vendor that can OWN a thread's browser pane. Kept in the same
  // preference order as SESSION_VENDOR_PREFERENCE in
  // browser-sessions/session-vendor-proxy.ts — this decides whether the
  // spawn tools appear, that decides which vendor a spawn actually uses, and
  // the two disagreeing would expose a tool that then refuses to run.
  // browserbase is in BOTH now; it was absent from both while it declared
  // supportsSessions() true and implemented one of the ten pane operations.
  //
  // The platform's own key (Steel, else Browser Use) is the last term, and it
  // moves the pane tools from TIER 2 to TIER 1 for the exact reason this file's
  // header gives:
  // they now have a platform-managed backend, so they exist for every agent by
  // default and the only gate left is the operator kill-switch. Binding stops
  // gating them for the same reason it does not gate web_research — binding
  // scopes what the WORKSPACE brought, and this backend is ours.
  const sessionVendorAgentOn =
    anchorAgentOn || byokAgent('browserbase') || byokAgent('steel') ||
    byokAgent('browser_use') || platformPaneOn;

  // Thread-global: any session on the thread = read tool available. Prefer a
  // caller-supplied result (avoids a duplicate query when the turn already
  // prefetched the session); otherwise resolve it here from threadId.
  const hasActiveBrowserSession =
    ctx.hasActiveBrowserSession
    ?? (ctx.threadId ? !!(await repo.getActiveForThread(tenantId, ctx.threadId)) : false);
  // run_browser_task is broader — it can also create a session. Available when:
  //   - there's already one (then it acts on it), OR
  //   - a session vendor serves this agent AND there is someone to open a
  //     browser under: a message sender on a thread, or the team itself on a
  //     run with no thread (the session is the run's, under the team's own
  //     profile, and ends with the run).
  const canSpawnBrowserSession =
    sessionVendorAgentOn && (!!ctx.messageSenderAccountId || ctx.autonomousRun === true);
  const canRunBrowserTask = hasActiveBrowserSession || canSpawnBrowserSession;
  const threadHasBrowserRecord = ctx.threadHasBrowserRecord === true;

  type RequireCtx = {
    anchorAgentOn: boolean;
    sessionVendorAgentOn: boolean;
    hasActiveBrowserSession: boolean;
    canRunBrowserTask: boolean;
    threadHasBrowserRecord: boolean;
  };
  const requireCtx: RequireCtx = {
    anchorAgentOn, sessionVendorAgentOn, hasActiveBrowserSession, canRunBrowserTask, threadHasBrowserRecord,
  };

  // In the default inline mode every retrieved skill is already in the prompt in
  // full, so read_skill would be a tool with nothing left to fetch. Exposing it
  // anyway would cost a schema on every call and invite the model to spend a
  // round trip re-reading text it can already see.
  //
  // Resolved through skillDisclosureMode rather than read from the environment
  // here, so this gate and the prompt render cannot answer the question
  // differently — they are two halves of one decision.
  const skillDisclosureOn =
    resolveSkillDisclosureMode(ctx.skillDisclosureMode) === 'disclosed';

  const TOOL_REQUIRES: Record<string, (ctx: RequireCtx) => boolean> = {
    read_skill:                  () => skillDisclosureOn,
    // Native-backed → tenant-level availability.
    web_fetch_advanced:          () => anyBackend,
    web_search:                  () => bridgedSearchOn,
    web_research:                () => anyResearchBackend,
    web_people_search:           () => perplexityOn,
    // X is a capability no other vendor has, and the agent's own model has
    // nothing to do with reaching it — a Claude or Gemini agent gets this the
    // same way it gets Perplexity-backed people search.
    web_x_search:                () => xaiOn,
    web_finance_search:          () => perplexityOn,
    web_deep_research:           () => anyDeepResearchBackend,
    // BYOK-exclusive → per-agent binding required.
    web_extract:                 () => anyExtractBackend,
    web_diff:                    () => webclawAgentOn,
    web_task:                    ({ anchorAgentOn }) => anchorAgentOn,
    web_identity_connect:        ({ anchorAgentOn }) => anchorAgentOn,
    // Anchor-only: createProfileFromSession snapshots the CURRENT session into
    // a named profile. Browser Use binds a profile at session creation and has
    // no "save this session as one" endpoint, so there is nothing to call.
    web_session_save:            ({ anchorAgentOn }) => anchorAgentOn,
    // NOT Anchor-only. Both handlers dispatch on the stored row's own vendor
    // (PROFILE_VENDORS), so a Browser Use agent has real profiles to list and
    // forget. Leaving these anchor-gated meant it accumulated saved logins it
    // could neither see nor delete — the worst half of a credential store.
    web_session_list:            ({ sessionVendorAgentOn }) => sessionVendorAgentOn,
    web_session_forget:          ({ sessionVendorAgentOn }) => sessionVendorAgentOn,
    // Closing operates on an EXISTING session, like read_active_browser_session
    // / run_browser_task — so it's available whenever there's an active session
    // to close, not only to anchor-bound agents. (web_session_save is setup, so
    // it stays anchor-only.)
    web_session_close:           ({ sessionVendorAgentOn, hasActiveBrowserSession }) => sessionVendorAgentOn || hasActiveBrowserSession,
    read_active_browser_session: ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    // Same gate as run_browser_task, and for the same reason: the palette is
    // assembled ONCE per turn, so gating on an EXISTING session means the tool
    // can never appear in the turn that creates one. The agent would call
    // start_browser_session, still not see a way to navigate, and improvise —
    // which is exactly what happened: it answered from a plain web fetch and
    // described a page the person was not looking at.
    // Works on any session vendor; the handler spawns one if needed.
    navigate_browser_session:    ({ canRunBrowserTask }) => canRunBrowserTask,
    // Same posture as read_active_browser_session — operates on an
    // existing session, so the gate is "is there a live session on
    // this thread" rather than "is the agent anchor-bound."
    // Collecting a task that carried on: offered whenever the browser is
    // there to have been working, which is the same condition as the rest.
    check_browser_task:              ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    list_browser_downloads:          ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    save_active_browser_page_as_pdf: ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    fetch_browser_download:          ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    get_browser_session_stats:       ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    screenshot_browser_session:      ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    check_browser_intervention_pending: ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    // The fine-grained pane actions and the request for the person to take
    // over act on an EXISTING session, like read_active_browser_session.
    read_browser_session_controls:      ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    act_in_browser_session:             ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    ask_person_to_take_over_browser_session: ({ hasActiveBrowserSession }) => hasActiveBrowserSession,
    // The record outlives the session: a person may ask what they did in a
    // browser that has since closed, so the read is offered on a record too.
    read_browser_session_activity:      ({ hasActiveBrowserSession, threadHasBrowserRecord }) =>
      hasActiveBrowserSession || threadHasBrowserRecord,
    // start_browser_session is broader: same gate as run_browser_task — either
    // there's already a session (this becomes a no-op return of the existing
    // id) or the agent is bound to anchor_browser AND there's a message
    // sender we can attribute ownership to (it actually spawns).
    start_browser_session:           ({ canRunBrowserTask }) => canRunBrowserTask,
    // Needs ANCHOR's in-session agent, which no other session vendor has, so
    // this stays anchor-gated even though start_browser_session no longer is.
    // The handler refuses on a non-anchor session; exposing it anyway would
    // advertise a capability the thread's browser cannot honour.
    run_browser_task:            ({ sessionVendorAgentOn, hasActiveBrowserSession }) =>
      sessionVendorAgentOn || hasActiveBrowserSession,
  };

  return standardTools.filter(t => {
    const requires = TOOL_REQUIRES[t.name];
    return requires === undefined ? true : requires(requireCtx);
  });
}
