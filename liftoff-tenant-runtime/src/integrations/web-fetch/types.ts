/**
 * Discriminated union of every supported web-tools vendor.
 *
 * ADDING A NEW VENDOR — touch all of these (compiler catches some, not all):
 *  1. This union
 *  2. global-flags.ts — local WebVendor re-declaration + VendorFlags interface + getAllVendorFlags()
 *  3. limits-config.ts — DEFAULTS table (concurrency + per-tool RPH)
 *  4. expose-tools.ts — destructure + TOOL_REQUIRES predicates
 *  5. router.ts — constructor param, buildFetchChain, per-tool chains,
 *                 per-tool runChain invoke switches, isTransient classifier
 *  6. diagnostic-router.ts — results init + iteration array
 *  7. web-tool-secrets.ts — WebToolSecretName union
 *  8. standard-tool-handler.ts — module-singleton + WebFetchRouter constructor wiring
 *  9. New <vendor>-client.ts implementing WebFetchAdvancedClient
 * 10. (PB) vendor-spend-monitor.ts — TIER_LIMITS_USD entry
 * 11. (PB) web-tools-cost-provider.ts — connector enum comment
 * 12. (Infra) platform-control/main.tf — google_secret_manager_secret
 *             tenant-runtime-template/main.tf — runtime_web_tool_keys for_each set
 *             modules/web-tools/secrets.tf — web_tool_secrets list
 *             modules/web-tools/schedulers.tf — quota poll job (if usage API)
 *             modules/web-tools/alerts.tf — vendor_quota_high OR-filter (if quota poller)
 * 13. If vendor exposes a usage API: new <vendor>-quota-monitor.ts +
 *     /api/jobs/<vendor>-quota-poll route in jobs/router.ts.
 *
 * `xai` was added for web_x_search and needed NO new infrastructure: the
 * platform's xai-api-key already existed in YOUR_GCP_PROJECT for
 * the LLM path, granted to the same runtime service account, and
 * `getWebToolSecret` reads that project. It exposes no usage API worth polling,
 * so 13 does not apply to it.
 */
// browserbase_x402 is the Browserbase pay-per-use gateway, reached through
// connector-service, which pays each call from the platform x402 wallet. No
// key, no secret and no connector on this side. It is the LAST rung of the
// fetch and search chains, behind the platform browser (see router.ts).
// locus_web is the platform's pay-per-use page scrape, search and extract,
// reached through connector-service on the platform's Locus key (Firecrawl
// behind it, at its listed per-call prices; the platform's own Firecrawl key
// is a free plan with no pay-as-you-go). A platform-tier rung behind a team's
// own accounts and ahead of the browsers.
// locus_exa is Exa's own x402 API resold per call on the platform's Locus key:
// the same page read and search the platform serves on its Exa key, taken
// only when that key is rate-limited (its plan is capped at ten queries a
// second), directly behind it in the platform tier.
// The admission ratchet reads this union up to its terminating semicolon, so
// no comment goes inside it.
export type WebVendor =
  | 'webclaw' | 'firecrawl' | 'perplexity' | 'anchor' | 'browserbase'
  | 'tavily' | 'exa' | 'openai' | 'google' | 'browser_use' | 'xai' | 'steel'
  | 'browserbase_x402' | 'locus_web' | 'locus_exa';

/** Which account paid the vendor for one web-tool call.
 *
 *  A property of the REQUEST, not of the vendor. The same vendor is BYOK for a
 *  workspace that connected its own key and platform-funded for one that did
 *  not, and the two bill in opposite directions, so the answer has to travel
 *  with the result rather than be looked up again downstream.
 *
 *  'x402_wallet': the platform's x402 wallet paid the vendor per call. Billing
 *  books such a row under its own bucket (real Operating Units, counted per
 *  call) — the bucket the on-chain reconciliation sums. */
export type WebToolFunding = 'tenant_key' | 'platform' | 'x402_wallet';

export interface UserInterventionInfo {
  reason: string;
  resumeHint: string;
}

// ── web_fetch_advanced ──────────────────────────────────────────────────────

export interface WebFetchAdvancedRequest {
  url: string;
  sessionId?: string;
  waitFor?: { type: 'selector'; value: string } | { type: 'networkidle' } | { type: 'time'; ms: number };
  vendorProfileId?: string;
  vendorIdentityId?: string;
  tenantId?: string;
  agentId?: string;
}

export interface InternalWebFetchAdvancedResult {
  content: string;
  finalUrl: string;
  sessionId?: string;
  liveViewUrl?: string;
  requiresUserIntervention?: UserInterventionInfo;
  vendor: WebVendor;
  costMicros: number;
  jsRendered: boolean;
  /** Whose key paid the vendor for this call. Set only by vendors that have
   *  BOTH a platform key and a BYOK connector — browser_use today — because
   *  only there does the answer vary per tenant. Billing reads it to decide
   *  whether the row debits Operating Units or merely records what the
   *  workspace spent on its own account.
   *
   *  Absent means "the vendor's usual funding", which for every strict BYOK
   *  vendor is the tenant's own key. Billing must therefore treat undefined as
   *  tenant-funded: erring the other way charges a workspace for browser time
   *  it already paid Browser Use for. */
  funding?: WebToolFunding;
}

export interface WebFetchAdvancedResult {
  content: string;
  finalUrl: string;
  sessionId?: string;
  liveViewUrl?: string;
  requiresUserIntervention?: UserInterventionInfo;
}

export function toAgentResult(r: InternalWebFetchAdvancedResult): WebFetchAdvancedResult {
  return {
    content: r.content,
    finalUrl: r.finalUrl,
    sessionId: r.sessionId,
    liveViewUrl: r.liveViewUrl,
    requiresUserIntervention: r.requiresUserIntervention,
  };
}

// ── web_extract ─────────────────────────────────────────────────────────────

export interface WebExtractRequest {
  url: string;
  schema: object;
  prompt?: string;
  sessionId?: string;
  vendorProfileId?: string;
  vendorIdentityId?: string;
  waitFor?: WebFetchAdvancedRequest['waitFor'];
}

export interface InternalWebExtractResult {
  data: unknown;
  finalUrl: string;
  sessionId?: string;
  liveViewUrl?: string;
  requiresUserIntervention?: UserInterventionInfo;
  vendor: WebVendor;
  costMicros: number;
  jsRendered: boolean;
  /** Whose money paid the vendor; see InternalWebFetchAdvancedResult.funding.
   *  Set by the platform extract rung; the BYOK vendors bill on the tenant's key. */
  funding?: WebToolFunding;
}

export interface WebExtractResult {
  data: unknown;
  finalUrl: string;
  sessionId?: string;
  liveViewUrl?: string;
  requiresUserIntervention?: UserInterventionInfo;
}

export function toAgentExtractResult(r: InternalWebExtractResult): WebExtractResult {
  return {
    data: r.data,
    finalUrl: r.finalUrl,
    sessionId: r.sessionId,
    liveViewUrl: r.liveViewUrl,
    requiresUserIntervention: r.requiresUserIntervention,
  };
}

// ── web_task ────────────────────────────────────────────────────────────────

export interface WebTaskRequest {
  task: string;
  startingUrl?: string;
  outputSchema?: object;
  maxSteps?: number;
  sessionId?: string;
  vendorProfileId?: string;
  vendorIdentityId?: string;
  /** Injected by WebFetchRouter when sessionId is present so AnchorClient.task
   *  can call ensureSession() with the right tenant scope. Handlers do not set
   *  these directly. The strict clients narrow the type at their public
   *  method boundary via `WithTenant<T> = T & { tenantId: string; agentId?: string }`
   *  so a router-bound call satisfies the required field even though the base
   *  type leaves them optional for handler-side construction. */
  tenantId?: string;
  agentId?: string;
  /** PR2: chat thread id, propagated through standard-tool-handler so the
   *  AnchorClient can bind the web_sessions row to a thread for dashboard
   *  surfacing and webhook routing. */
  threadId?: string;
}

export interface InternalWebTaskResult {
  result: unknown;
  sessionId?: string;
  liveViewUrl?: string;
  requiresUserIntervention?: UserInterventionInfo;
  vendor: WebVendor;
  costMicros: number;
  /** True when the router/vendor created a fresh session for this call (i.e.
   *  the caller did not pass an explicit session_id). Handlers use this to
   *  auto-close the session in a finally block so the concurrency slot frees
   *  immediately rather than waiting for the 10-min idle TTL. */
  createdSessionLocally?: boolean;
}

export interface WebTaskResult {
  result: unknown;
  sessionId?: string;
  liveViewUrl?: string;
  requiresUserIntervention?: UserInterventionInfo;
}

export function toAgentTaskResult(r: InternalWebTaskResult): WebTaskResult {
  return {
    result: r.result,
    sessionId: r.sessionId,
    liveViewUrl: r.liveViewUrl,
    requiresUserIntervention: r.requiresUserIntervention,
  };
}

// ── web_research ────────────────────────────────────────────────────────────

export interface WebResearchRequest {
  question: string;
  maxSources?: number;
  outputSchema?: object;
}

export interface InternalWebResearchResult {
  answer: string | unknown;
  sources: Array<{ url: string; title: string; snippet?: string }>;
  vendor: WebVendor;
  costMicros: number;
  /** Whose money paid the vendor; see InternalWebFetchAdvancedResult.funding.
   *  Set when the platform's own key served a vendor a team is not bound to. */
  funding?: WebToolFunding;
}

export interface WebResearchResult {
  answer: string | unknown;
  sources: Array<{ url: string; title: string; snippet?: string }>;
}

export function toAgentResearchResult(r: InternalWebResearchResult): WebResearchResult {
  return { answer: r.answer, sources: r.sources };
}

// ── web_search ─────────────────────────────────────────────────────────────
//
// The BASIC search: a query in, ranked results out — url, title, snippet — at
// a flat per-request price, with no synthesis. The bridged half of the rule
// every engine follows for search: the model vendor's own hosted search where
// the vendor has one (Claude's WebSearch, Codex's and the wire's web_search,
// Gemini's grounding), and this tool otherwise — on xAI's search for a Grok
// run, on Perplexity's for the open-weights families. `web_research` is the
// ADVANCED tier: a synthesized, cited answer from several sources.

export interface WebSearchRequest {
  query: string;
  /** Upper bound on results. Each backend caps it further (Perplexity 20). */
  maxResults?: number;
}

export interface InternalWebSearchResult {
  results: Array<{ url: string; title: string; snippet?: string; date?: string }>;
  /** What the backend said about the results, when it says anything: xAI
   *  answers in prose with citations, Perplexity's Search API returns results
   *  and nothing else. */
  summary?: string;
  vendor: WebVendor;
  costMicros: number;
  /** Whose money paid the vendor; see InternalWebFetchAdvancedResult.funding.
   *  Set by the x402 rung only — the platform search vendors bill on their
   *  usual funding. */
  funding?: WebToolFunding;
}

export interface WebSearchResult {
  results: InternalWebSearchResult['results'];
  summary?: string;
}

// ── web_x_search ───────────────────────────────────────────────────────────
//
// Search X (posts, profiles, threads) through xAI's hosted x_search. A PLATFORM
// tool rather than a Grok-only one: it is a capability no other vendor has, and
// which model an agent happens to run on should not decide whether the platform
// can reach X. Any agent gets it, on any provider — the same way
// web_people_search is Perplexity-backed without making an agent run
// on Perplexity.
//
// Returns narrative + citations rather than structured records, because that is
// what xAI returns: x_search fans out to x_keyword_search / x_semantic_search
// internally and answers in prose, annotating it with `url_citation` entries
// that point at the individual posts. Inventing a record shape it does not
// produce would mean parsing prose and guessing.

export interface WebXSearchRequest {
  query: string;
  /** Upper bound on posts consulted. Advisory: xAI decides its own fan-out. */
  maxSources?: number;
  /** ISO date. Only posts on or after it are considered. */
  fromDate?: string;
  /** Restrict to posts from these handles, without the @. */
  handles?: string[];
}

export interface InternalWebXSearchResult {
  answer: string;
  sources: Array<{ url: string; title: string }>;
  vendor: WebVendor;
  costMicros: number;
}

export interface WebXSearchResult {
  answer: string;
  sources: InternalWebXSearchResult['sources'];
}

// ── web_diff ────────────────────────────────────────────────────────────────

export interface WebDiffRequest {
  urlA: string;
  urlB: string;
}

export interface InternalWebDiffResult {
  status: string;
  textDiff: string;
  metadataChanges: unknown;
  linksAdded: string[];
  linksRemoved: string[];
  wordCountDelta: number;
  vendor: WebVendor;
  costMicros: number;
}

export interface WebDiffResult {
  status: string;
  textDiff: string;
  metadataChanges: unknown;
  linksAdded: string[];
  linksRemoved: string[];
  wordCountDelta: number;
}

export function toAgentDiffResult(r: InternalWebDiffResult): WebDiffResult {
  const { vendor: _v, costMicros: _c, ...rest } = r;
  return rest;
}

// ── web_identity_connect ────────────────────────────────────────────────────

export interface WebIdentityConnectRequest {
  serviceName: string;
  loginUrl: string;
  identityName: string;
  credentialTypes?: Array<'username_password' | 'authenticator' | 'custom'>;
}

export interface InternalWebIdentityConnectResult {
  connectUrl: string;
  identityName: string;
  vendorIdentityId: string;
  vendor: WebVendor;
  costMicros: number;
}

export interface WebIdentityConnectResult {
  connectUrl: string;
  identityName: string;
}

export function toAgentIdentityResult(r: InternalWebIdentityConnectResult): WebIdentityConnectResult {
  return { connectUrl: r.connectUrl, identityName: r.identityName };
}

// ── web_session_save ────────────────────────────────────────────────────────

export interface InternalWebSessionSaveResult {
  profileName: string;
  vendor: WebVendor;
  costMicros: number;
}

export interface WebSessionSaveResult {
  profileName: string;
  saved: true;
}

export function toAgentSessionSaveResult(r: InternalWebSessionSaveResult): WebSessionSaveResult {
  return { profileName: r.profileName, saved: true };
}

// ── web_people_search ─────────────────────────────────────────────────────

export interface WebPeopleSearchRequest {
  query: string;
  maxSources?: number;
  filters?: { company?: string; title?: string; location?: string };
}

export interface InternalWebPeopleSearchResult {
  results: Array<{
    name: string;
    title?: string;
    company?: string;
    location?: string;
    sources: string[];
  }>;
  vendor: WebVendor;
  costMicros: number;
}

export interface WebPeopleSearchResult {
  results: InternalWebPeopleSearchResult['results'];
}

export function toAgentPeopleSearchResult(r: InternalWebPeopleSearchResult): WebPeopleSearchResult {
  return { results: r.results };
}

// ── web_finance_search ────────────────────────────────────────────────────

export interface WebFinanceSearchRequest {
  query: string;
  instrument?: string;
  maxSources?: number;
}

export interface InternalWebFinanceSearchResult {
  results: Array<{
    ticker?: string;
    instrument: string;
    summary: string;
    sources: string[];
  }>;
  vendor: WebVendor;
  costMicros: number;
}

export interface WebFinanceSearchResult {
  results: InternalWebFinanceSearchResult['results'];
}

export function toAgentFinanceSearchResult(r: InternalWebFinanceSearchResult): WebFinanceSearchResult {
  return { results: r.results };
}

// ── web_deep_research ─────────────────────────────────────────────────────

export interface WebDeepResearchRequest {
  question: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'highest';
  maxWaitMs?: number;
  /** Injected by WebFetchRouter so PerplexityClient can write the
   *  registry row. Handlers do not set these directly. */
  tenantId?: string;
  agentId?: string;
}

export interface InternalWebDeepResearchResult {
  report: string;
  sources: Array<{ url: string; title?: string; date?: string }>;
  vendor: WebVendor;
  costMicros: number;
  deepResearchId: string;
  usage: {
    prompt_tokens:      number;
    completion_tokens:  number;
    citation_tokens:    number;
    reasoning_tokens:   number;
    num_search_queries: number;
    search_context_size?: number;
  };
  durationMs: number;
}

export interface WebDeepResearchResult {
  report: string;
  sources: InternalWebDeepResearchResult['sources'];
}

export function toAgentDeepResearchResult(r: InternalWebDeepResearchResult): WebDeepResearchResult {
  return { report: r.report, sources: r.sources };
}

// ── Client contracts ────────────────────────────────────────────────────────

export interface WebFetchAdvancedClient {
  readonly vendor: WebVendor;
  fetch(request: WebFetchAdvancedRequest): Promise<InternalWebFetchAdvancedResult>;
  extract?(request: WebExtractRequest): Promise<InternalWebExtractResult>;
  task?(request: WebTaskRequest): Promise<InternalWebTaskResult>;
  research?(request: WebResearchRequest): Promise<InternalWebResearchResult>;
  /** The basic search: ranked results at a flat price, no synthesis. */
  search?(request: WebSearchRequest): Promise<InternalWebSearchResult>;
  diff?(request: WebDiffRequest): Promise<InternalWebDiffResult>;
  identityCreate?(request: WebIdentityConnectRequest): Promise<InternalWebIdentityConnectResult>;
  supportsSessions(): boolean;
}

// ── BYOK error envelope ─────────────────────────────────────────────────
//
// Thrown by the six strict-policy BYOK web-tool clients when their vendor
// classifies a request as `insufficient_funds` or `invalid_key`. The
// byok-error-handler catches it, calls MarkConnectorError, and invalidates
// the resolver cache. `message` carries the labeled-block envelope that
// the LLM relays to the user verbatim (see agent-execution system prompt).

export type VendorErrorCode =
  | 'insufficient_funds' | 'invalid_key' | 'rate_limited' | 'vendor_down';

export class BYOKVendorError extends Error {
  constructor(
    public readonly code: VendorErrorCode,
    public readonly vendor: string,
    public readonly tenantId: string,
    public readonly connectorId: string,
    message: string,
  ) {
    super(message);
    this.name = 'BYOKVendorError';
  }
}
