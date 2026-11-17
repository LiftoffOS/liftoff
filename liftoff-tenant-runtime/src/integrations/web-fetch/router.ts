import { logger } from '../../infrastructure/logging';
import { getPool } from '../../infrastructure/database';
import { getAllVendorFlags, isVendorEnabled, isVendorExcludedForTenant, isEffortRoutingEnabled } from './global-flags';
import { usableWebVendors, logExcludedVendors, type WebVendorScope } from './vendor-scope';
import { scopeFor, type CredentialScope } from './credential-scope';
import {
  CONNECTOR_TYPE_OF, vendorAvailable, tierOf, orderFetchChain, orderResearchChain, PLATFORM_EXTRACT_ORDER, PLATFORM_SEARCH_ORDER,
  type VendorTier,
} from './vendor-order';
import { WebClawClient, WebClawError } from './webclaw-client';
import { FirecrawlClient, FirecrawlError } from './firecrawl-client';
import { PerplexityClient, PerplexityError, type DeepResearchHooks } from './perplexity-client';
import { AnchorClient, AnchorError } from './anchor-client';
import { BrowserbaseClient, BrowserbaseError } from './browserbase-client';
import { BrowserUseClient, BrowserUseError } from './browser-use-client';
import { SteelClient, SteelError } from './steel-client';
import { BrowserbaseX402Client, BrowserbaseX402Error } from './browserbase-x402-client';
import { LocusWebClient, LocusWebError } from './locus-web-client';
import { LocusExaClient } from './locus-exa-client';
import { TavilyClient, TavilyError } from './tavily-client';
import { ExaClient, ExaError } from './exa-client';
import { OpenAIClient, OpenAIError } from './openai-client';
import { GoogleClient, GoogleError, type GoogleModelVariant } from './google-client';
import { acquireInflightSlot, VendorPoolBusy, type InflightHandle } from './concurrency-limits';
import { consumeToken } from './token-bucket';
import { XaiClient } from './xai-client';
import type {
  WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
  WebExtractRequest, InternalWebExtractResult,
  WebTaskRequest, InternalWebTaskResult,
  WebResearchRequest, InternalWebResearchResult,
  WebPeopleSearchRequest, InternalWebPeopleSearchResult,
  WebFinanceSearchRequest, InternalWebFinanceSearchResult,
  WebDeepResearchRequest, InternalWebDeepResearchResult,
  WebDiffRequest, InternalWebDiffResult,
  WebXSearchRequest, InternalWebXSearchResult,
  WebSearchRequest, InternalWebSearchResult,
  WebVendor,
} from './types';
import { isOriginPageMiss, ExtractionEmpty, PageUnretrievable } from './origin-miss';
import { vendorRateLimit } from './vendor-rate-limit';
import { redactUrl } from './url-redactor';

export { PageUnretrievable } from './origin-miss';

/** One vendor's failure on one call of the chain, as the exhaustion
 *  classifier sees it and as `PageUnretrievable` carries it out. */
export interface ChainFailure {
  vendor: WebVendor;
  /** The vendor's message, URLs redacted, bounded. Never the raw error. */
  reason: string;
  /** The error itself, for the classifier only; not carried out. */
  error: unknown;
}

/** The reason text that leaves the router: bounded, with every URL in it
 *  passed through the same redaction the handlers apply. */
const REASON_MAX_CHARS = 200;
function boundedReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = raw.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (u) => redactUrl(u));
  return redacted.length > REASON_MAX_CHARS ? `${redacted.slice(0, REASON_MAX_CHARS - 1)}…` : redacted;
}

/** The classifier `fetch` and `extract` hand `runChain`: a `PageUnretrievable`
 *  iff every failure of the call was an origin page miss, else null, which is
 *  today's `throw lastErr`. */
function pageMissClassifier(url: string): (failures: ChainFailure[]) => Error | null {
  return (failures) => {
    if (failures.length === 0) return null;
    if (!failures.every((f) => isOriginPageMiss(f.vendor, f.error))) return null;
    return new PageUnretrievable(url, failures.map((f) => ({ vendor: f.vendor, reason: f.reason })));
  };
}

const VENDOR_HEALTH_TTL_MS = 60_000;

export class VendorHealthCache {
  private blocked = new Map<WebVendor, number>();
  markFailed(v: WebVendor)  { this.blocked.set(v, Date.now() + VENDOR_HEALTH_TTL_MS); }
  isHealthy(v: WebVendor)   { const t = this.blocked.get(v); return !t || Date.now() > t; }
}

export const vendorHealthCache = new VendorHealthCache();

// ──────────────────────────────────────────────────────────────────────
// Vendor availability and order live in vendor-order.ts — one table for the
// fetch chain, the research chain and the browser session picker. A vendor
// is available to a RUN iff the operator has not pulled its kill-switch
// (web_fetch_vendor_<vendor>) AND it is platform-managed, or the team is bound
// to the workspace's connector for it (vendor-scope.ts), or the platform
// funds it when it is not. The team's own accounts are tried before the
// platform's. Per-vendor D12 tenant-exclusion is honored separately by
// deepResearch for the preview-tier paths (openai, google).
// ──────────────────────────────────────────────────────────────────────

/** The credential scope a run's vendor scope gives one connector-backed
 *  vendor: its bound connector ids, any connector for a type-only binding, or
 *  NO workspace connector for a vendor the team is not bound to — which is
 *  how a platform-funded vendor (steel, browser_use) lands on the platform key
 *  rather than on an unbound workspace account. Every connector-backed client
 *  call below carries it, and the clients refuse a call without one. */
function credentialScopeFor(scope: WebVendorScope, v: WebVendor): CredentialScope {
  const ct = CONNECTOR_TYPE_OF[v];
  if (ct === null) throw new Error(`vendor ${v} is platform-managed and takes no credential scope`);
  return scopeFor(scope, ct);
}

export class WebFetchRouter {
  constructor(
    private readonly webclaw: WebClawClient,
    private readonly firecrawl: FirecrawlClient,
    private readonly perplexity: PerplexityClient,
    private readonly anchor: AnchorClient,
    private readonly browserbase: BrowserbaseClient,
    private readonly tavily: TavilyClient,
    private readonly exa: ExaClient,
    private readonly openai: OpenAIClient,
    private readonly google: GoogleClient,
    private readonly browserUse: BrowserUseClient,
    private readonly xai: XaiClient,
    private readonly steel: SteelClient = new SteelClient(),
    private readonly health: VendorHealthCache = vendorHealthCache,
    private readonly browserbaseX402: BrowserbaseX402Client = new BrowserbaseX402Client(),
    private readonly locusWeb: LocusWebClient = new LocusWebClient(),
    private readonly locusExa: LocusExaClient = new LocusExaClient(),
  ) {}

  async fetch(
    req: WebFetchAdvancedRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string },
  ): Promise<InternalWebFetchAdvancedResult> {
    const [flags, scope] = await Promise.all([
      getAllVendorFlags(), usableWebVendors(ctx.tenantId, ctx.agentId),
    ]);
    logExcludedVendors(scope, { ...ctx, toolName: 'web_fetch_advanced' });
    const sessionVendor = req.sessionId ? await this.lookupSessionVendor(req.sessionId, ctx.tenantId) : null;
    const chain = sessionVendor ? [sessionVendor] : orderFetchChain(!!req.waitFor, flags, scope, this.health);
    // Every vendor answered and the page gave nothing back: that is a fact
    // about the page, and it leaves here as one (PageUnretrievable). Only this
    // call and `extract` classify exhaustion this way — a research or a task
    // that comes back empty is not a missing page.
    return this.runChain(chain, { ...ctx, toolName: 'web_fetch_advanced' }, async (v, _handle) => {
      const bound = (vendor: WebVendor) => ({ ...req, tenantId: ctx.tenantId, credentialScope: credentialScopeFor(scope, vendor) });
      switch (v) {
        case 'webclaw':     return this.webclaw.fetch(bound(v));
        case 'firecrawl':   return this.firecrawl.fetch(bound(v));
        case 'perplexity':  return this.perplexity.fetch(req);
        case 'anchor':      return this.anchor.fetch({ ...bound(v), agentId: ctx.agentId });
        case 'browserbase': return this.browserbase.fetch({ ...bound(v), agentId: ctx.agentId });
        case 'tavily':      return this.tavily.fetch(bound(v));
        case 'exa':         return this.exa.fetch(bound(v));
        case 'browser_use': return this.browserUse.fetch(bound(v));
        case 'steel':       return this.steel.fetch(bound(v));
        case 'browserbase_x402': return this.browserbaseX402.fetch({ ...req, tenantId: ctx.tenantId, traceId: ctx.traceId });
        case 'locus_web':   return this.locusWeb.fetch({ ...req, tenantId: ctx.tenantId, traceId: ctx.traceId });
        case 'locus_exa':   return this.locusExa.fetch({ ...req, tenantId: ctx.tenantId, traceId: ctx.traceId });
      }
    }, { classifyExhaustion: pageMissClassifier(req.url), tierOf: (v) => tierOf(v, scope) });
  }

  async extract(
    req: WebExtractRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string },
  ): Promise<InternalWebExtractResult> {
    const [flags, scope] = await Promise.all([
      getAllVendorFlags(), usableWebVendors(ctx.tenantId, ctx.agentId),
    ]);
    logExcludedVendors(scope, { ...ctx, toolName: 'web_extract' });
    const connected = scope.vendors;
    // Perplexity is intentionally NOT in the extract chain — its Agent API does
    // not expose a schema-guided structured-extraction primitive equivalent to
    // firecrawl's /v2/scrape json format. Wiring it would require a local
    // schema-guided LLM extraction helper that doesn't exist yet (see TR-5
    // extract() escape clause).
    //
    // The order below is COST TIER, not the browser-vendor preference that the
    // session tools use: browserbase sits ahead of anchor here deliberately and
    // must NOT be "fixed" to match. browser_use is absent for the same reason
    // perplexity is — it exposes no schema-guided extraction primitive at all.
    // The team's own accounts first, then the platform tier: the pay-per-use
    // extract on the platform's Locus key, the one platform extract backend,
    // which is what makes web_extract a tool every agent has.
    const chain: WebVendor[] = ['firecrawl', 'webclaw', 'browserbase', 'anchor', ...PLATFORM_EXTRACT_ORDER];
    const filtered = chain.filter(v => vendorAvailable(v, flags, connected) && this.health.isHealthy(v));
    // Result validation for the fetch-shaped calls lives HERE, once. `fetch`
    // already throws on empty content in every client; `extract` does not —
    // the firecrawl client returns `data: data.data?.json` and can hand back
    // `undefined` without throwing. A null or undefined extraction is a miss
    // for that vendor and the chain moves down; an empty object is a valid
    // extraction unless the schema proves otherwise, so `{}` is NOT a miss.
    const extractOn = async (v: WebVendor): Promise<InternalWebExtractResult> => {
      const bound = () => ({ ...req, tenantId: ctx.tenantId, credentialScope: credentialScopeFor(scope, v) });
      switch (v) {
        case 'webclaw':     return this.webclaw.extract!(bound());
        case 'firecrawl':   return this.firecrawl.extract!(bound());
        case 'browserbase': return this.browserbase.extract!(bound());
        case 'anchor':      return this.anchor.extract!(bound());
        case 'locus_web':   return this.locusWeb.extract({ ...req, tenantId: ctx.tenantId, traceId: ctx.traceId });
        default: throw new Error(`extract not supported on vendor ${v}`);
      }
    };
    return this.runChain(filtered, { ...ctx, toolName: 'web_extract' }, async (v, _handle) => {
      const out = await extractOn(v);
      if (out.data === undefined || out.data === null) throw new ExtractionEmpty(v);
      return out;
    }, { classifyExhaustion: pageMissClassifier(req.url) });
  }

  async task(
    req: WebTaskRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string; invocationId?: string },
  ): Promise<InternalWebTaskResult> {
    const [flags, scope] = await Promise.all([
      getAllVendorFlags(), usableWebVendors(ctx.tenantId, ctx.agentId),
    ]);
    logExcludedVendors(scope, { ...ctx, toolName: 'web_task' });
    // 2b: with the Jev loop on, a session on whichever vendor the session
    // picker chooses for this run, the loop over its CDP, closed after —
    // vendor-neutral. Anchor's task endpoint, credits and its agent's time
    // go away where the loop serves. A run with no invocation (nothing to
    // own a session), or no session vendor, takes today's path.
    if (ctx.invocationId && !req.sessionId) {
      const served = await this.runTaskOnRunSession(req, { ...ctx, invocationId: ctx.invocationId });
      if (served) return served;
    }
    if (!vendorAvailable('anchor', flags, scope.vendors)) {
      throw new Error('web_task backend unavailable');
    }
    return this.runChain(['anchor'], { ...ctx, toolName: 'web_task' }, async (_v, _handle) =>
      this.anchor.task!({ ...req, tenantId: ctx.tenantId, agentId: ctx.agentId, credentialScope: credentialScopeFor(scope, 'anchor') }),
    );
  }

  /** The loop over a run-owned session on the router-picked vendor. Null
   *  when the loop is off or no session could be opened, so the caller falls
   *  to today's path. */
  private async runTaskOnRunSession(
    req: WebTaskRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string; invocationId: string },
  ): Promise<InternalWebTaskResult | null> {
    const { isJevBrowserLoopEnabled } = await import('../../typesafe/flags');
    if (!isJevBrowserLoopEnabled()) return null;
    // Dynamic: the vendor proxy imports the vendor clients through the tool
    // handler, which imports this router.
    const proxy = await import('../../browser-sessions/session-vendor-proxy');
    let session: import('../../browser-sessions/types').BrowserSession;
    try {
      session = await proxy.createSessionForRun({ tenantId: ctx.tenantId, agentId: ctx.agentId, invocationId: ctx.invocationId });
    } catch (err) {
      logger.info({ err: (err as Error).message, tenantId: ctx.tenantId }, 'web_task: no run session for the loop; taking today\'s path');
      return null;
    }
    try {
      if (req.startingUrl) {
        await proxy.gotoUrl(session.vendor, session.vendorSessionId, ctx.tenantId, req.startingUrl);
      }
      const outcome = await proxy.runAgentTask(session.vendor, session.vendorSessionId, ctx.tenantId, req.task, {
        invocationId: ctx.invocationId,
        runtimeAgentId: ctx.agentId,
      });
      return {
        result: outcome.result ?? outcome.data ?? null,
        sessionId: session.id,
        vendor: session.vendor as WebVendor,
        // The loop's own model cost lands on the control plane per request;
        // the vendor's session cost is settled by the session close.
        costMicros: 0,
        createdSessionLocally: false,
      };
    } finally {
      await proxy.closeSession(session.vendor, session.vendorSessionId, ctx.tenantId).catch((err: Error) =>
        logger.warn({ err: err.message, sessionId: session.id }, 'web_task: session close failed'));
    }
  }

  async research(
    req: WebResearchRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string },
  ): Promise<InternalWebResearchResult> {
    const [flags, scope] = await Promise.all([
      getAllVendorFlags(), usableWebVendors(ctx.tenantId, ctx.agentId),
    ]);
    logExcludedVendors(scope, { ...ctx, toolName: 'web_research' });
    // The team's own accounts by cost, then Perplexity (vendor-order.ts).
    const chain = orderResearchChain(flags, scope, this.health);
    if (chain.length === 0) {
      throw new Error('web_research backend unavailable');
    }
    return this.runChain(chain, { ...ctx, toolName: 'web_research' }, async (v, _handle) => {
      const bound = () => ({ ...req, tenantId: ctx.tenantId, credentialScope: credentialScopeFor(scope, v) });
      switch (v) {
        case 'webclaw':    return this.webclaw.research!(bound());
        case 'firecrawl':  return this.firecrawl.research!(bound());
        case 'perplexity': return this.perplexity.research!(req);
        case 'exa':        return this.exa.research!(bound());
        case 'locus_exa':  return this.locusExa.research({ ...req, tenantId: ctx.tenantId, traceId: ctx.traceId });
        case 'tavily':     return this.tavily.research!(bound());
        default: throw new Error(`research not supported on vendor ${v}`);
      }
    }, { tierOf: (v) => tierOf(v, scope) });
  }

  async peopleSearch(
    req: WebPeopleSearchRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string },
  ): Promise<InternalWebPeopleSearchResult> {
    if (!(await isVendorEnabled('perplexity'))) {
      throw new Error('web_people_search backend unavailable');
    }
    return this.runChain(['perplexity'], { ...ctx, toolName: 'web_people_search' }, async (_v, _handle) =>
      this.perplexity.peopleSearch(req),
    );
  }

  /**
   * The BASIC web search, on the backend the run's provider owns.
   *
   * One rule, per engine: a model gets its vendor's own hosted search where
   * the engine can attach one, and this tool otherwise. So the backend is
   * chosen by PROVIDER — xAI's `web_search` for a Grok run, Perplexity's
   * Search API for the open-weights families (OpenRouter runs no hosted
   * tools on our behalf) — rather than by cost tier the way `web_research`
   * chooses: the point is that a Grok agent searches with Grok's search.
   * Perplexity is the fallback when xAI is switched off, so a Grok agent is
   * never left with no search at all; the result names the vendor that ran.
   */
  async search(
    req: WebSearchRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string; provider?: string },
  ): Promise<InternalWebSearchResult> {
    const flags = await getAllVendorFlags();
    // The x402 Browserbase gateway is the last rung, behind every platform
    // search vendor: runChain tries two vendors per call, so it runs only when
    // the vendors ahead of it are switched off or marked unhealthy. It does
    // not switch web_search on by itself (expose-tools gates the tool on the
    // platform search vendors), so a fallback never widens the tool surface.
    const preferred: WebVendor[] = ctx.provider === 'xai'
      ? ['xai', ...PLATFORM_SEARCH_ORDER]
      : [...PLATFORM_SEARCH_ORDER];
    const chain = preferred.filter(v => flags[v] && this.health.isHealthy(v));
    if (chain.length === 0) throw new Error('web_search backend unavailable');
    return this.runChain(chain, { ...ctx, toolName: 'web_search' }, async (v, _handle) => {
      switch (v) {
        case 'xai':        return this.xai.webSearch(req);
        case 'perplexity': return this.perplexity.search!(req);
        case 'browserbase_x402': return this.browserbaseX402.search(req, ctx);
        case 'locus_web':  return this.locusWeb.search(req, ctx);
        default: throw new Error(`search not supported on vendor ${v}`);
      }
    });
  }

  async xSearch(
    req: WebXSearchRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string },
  ): Promise<InternalWebXSearchResult> {
    if (!(await isVendorEnabled('xai'))) {
      throw new Error('web_x_search backend unavailable');
    }
    // A single-vendor chain, like people/finance search. Not a fallback list
    // with one entry by accident: no other vendor here can search X at all, so
    // a chain would have nothing to fall back TO.
    return this.runChain(['xai'], { ...ctx, toolName: 'web_x_search' }, async (_v, _handle) =>
      this.xai.xSearch(req),
    );
  }

  async financeSearch(
    req: WebFinanceSearchRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string },
  ): Promise<InternalWebFinanceSearchResult> {
    if (!(await isVendorEnabled('perplexity'))) {
      throw new Error('web_finance_search backend unavailable');
    }
    return this.runChain(['perplexity'], { ...ctx, toolName: 'web_finance_search' }, async (_v, _handle) =>
      this.perplexity.financeSearch(req),
    );
  }

  async deepResearch(
    req: WebDeepResearchRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string },
    hooks?: Omit<DeepResearchHooks, 'onHeartbeat'>,
  ): Promise<InternalWebDeepResearchResult> {
    const effort = req.reasoningEffort ?? 'low';

    // D21 migration gate. When false, all effort levels route to Perplexity
    // at the agent's effort value (legacy behavior). `highest` is rejected
    // at the handler when the flag is off, so we don't expect it here, but
    // we still defensively coerce it down to 'high' if it slips through.
    const routingEnabled = await isEffortRoutingEnabled();
    if (!routingEnabled) {
      if (!(await isVendorEnabled('perplexity'))) {
        throw new Error('web_deep_research backend unavailable');
      }
      const legacyEffort: 'low' | 'medium' | 'high' =
        effort === 'highest' ? 'high' : (effort as 'low' | 'medium' | 'high');
      return this.runChain(
        ['perplexity'],
        { ...ctx, toolName: 'web_deep_research' },
        async (_v, handle) => this.perplexity.deepResearch(
          { ...req, reasoningEffort: legacyEffort, tenantId: ctx.tenantId, agentId: ctx.agentId },
          { ...hooks, onHeartbeat: () => handle.refresh() },
        ),
      );
    }

    // D3/D8 effort → vendor chain mapping.
    //
    // Google Gemini Deep Research (standard + Max variants) is HARD-DISABLED
    // until Google Cloud makes the `deep-research-preview-04-2026` and
    // `deep-research-max-preview-04-2026` agents generally available. The
    // Interactions API currently 404s for these agents. The agent-facing
    // schema in `standard-tools.ts` exposes only `reasoning_effort: ['low',
    // 'high']`; the handler in `standard-tool-handler.ts` rejects `medium`
    // and `highest` at validation. This constant is the in-router belt-
    // and-suspenders so even if a request bypasses validation, Google is
    // never routed to. Flip to `false` when GCP ships the models AND
    // extend the schema enum + handler validation in lockstep.
    const GOOGLE_DEEP_RESEARCH_UNAVAILABLE = true;
    const googleExcludedForTenant = await isVendorExcludedForTenant(ctx.tenantId, 'google');
    const enabled: Record<'perplexity' | 'openai' | 'google', boolean> = {
      perplexity: await isVendorEnabled('perplexity'),
      openai:     await isVendorEnabled('openai'),
      google:     !GOOGLE_DEEP_RESEARCH_UNAVAILABLE
        && (await isVendorEnabled('google'))
        && !googleExcludedForTenant,
    };

    let chain: WebVendor[];
    // Only consulted when the chain hits 'google': standard Deep Research
    // for `medium`, Deep Research Max for `highest`. (Both are preview-tier
    // Gemini models; the name distinction is the product variant, not the
    // API release stage.)
    let googleVariant: GoogleModelVariant = 'standard';
    switch (effort) {
      case 'low':
        chain = enabled.perplexity ? ['perplexity'] : [];
        break;
      case 'medium':
        googleVariant = 'standard';
        chain = (['google', 'perplexity'] as WebVendor[])
          .filter(v => enabled[v as 'google' | 'perplexity']);
        break;
      case 'high':
        chain = (['openai', 'perplexity'] as WebVendor[])
          .filter(v => enabled[v as 'openai' | 'perplexity']);
        break;
      case 'highest':
        googleVariant = 'max';
        chain = (['google', 'openai'] as WebVendor[])
          .filter(v => enabled[v as 'google' | 'openai']);
        break;
      default:
        throw new Error(`invalid reasoning_effort: ${effort}`);
    }
    chain = chain.filter(v => this.health.isHealthy(v));

    if (chain.length === 0) {
      throw new Error(`web_deep_research backends unavailable for reasoning_effort=${effort}`);
    }

    return this.runChain(
      chain,
      { ...ctx, toolName: 'web_deep_research' },
      async (v, handle) => {
        const wrappedHooks: DeepResearchHooks = {
          ...hooks,
          onHeartbeat: () => handle.refresh(),
        };
        switch (v) {
          case 'perplexity':
            // D5: Perplexity-internal reasoning_effort is FIXED at 'high'
            // regardless of the agent's tier (also true when Perplexity is
            // the fallback for `medium` or `high`). Rationale: even the
            // cheapest tier should deliver Perplexity's best output quality;
            // cost delta is minimal ($0.40 vs $0.75 per call).
            return this.perplexity.deepResearch(
              { ...req, reasoningEffort: 'high', tenantId: ctx.tenantId, agentId: ctx.agentId },
              wrappedHooks,
            );
          case 'openai':
            return this.openai.deepResearch(req, wrappedHooks);
          case 'google':
            return this.google.deepResearch(
              { ...req, variant: googleVariant },
              wrappedHooks,
            );
          default:
            throw new Error(`unexpected vendor in deepResearch chain: ${v}`);
        }
      },
      { fallbackOnAdmissionBlock: true },                          // D12
    );
  }

  async diff(
    req: WebDiffRequest,
    ctx: { tenantId: string; agentId: string; traceId?: string },
  ): Promise<InternalWebDiffResult> {
    const [flags, scope] = await Promise.all([
      getAllVendorFlags(), usableWebVendors(ctx.tenantId, ctx.agentId),
    ]);
    logExcludedVendors(scope, { ...ctx, toolName: 'web_diff' });
    if (!vendorAvailable('webclaw', flags, scope.vendors)) {
      throw new Error('web_diff backend unavailable');
    }
    return this.runChain(['webclaw'], { ...ctx, toolName: 'web_diff' }, async (_v, _handle) =>
      this.webclaw.diff!({ ...req, tenantId: ctx.tenantId, credentialScope: credentialScopeFor(scope, 'webclaw') }),
    );
  }

  private async runChain<T extends { vendor: WebVendor }>(
    chain: WebVendor[],
    ctx: { traceId?: string; tenantId: string; agentId: string; toolName: string },
    invoke: (v: WebVendor, handle: InflightHandle) => Promise<T>,
    opts?: {
      fallbackOnAdmissionBlock?: boolean;
      /** Decide what the call's exhaustion means from EVERY vendor failure it
       *  saw. Non-null replaces `throw lastErr`; null keeps it. Only the
       *  fetch-shaped calls pass one. */
      classifyExhaustion?: (failures: ChainFailure[]) => Error | null;
      /** Which tier each vendor serves from, for the attempt budget below.
       *  A chain with no tiers keeps the flat cap of two. */
      tierOf?: (_vendor: WebVendor) => VendorTier;
    },
  ): Promise<T> {
    if (chain.length === 0) throw new Error('no web fetch backends available');
    let lastErr: Error | undefined;
    /** Every vendor failure of THIS call, in chain order, beside `lastErr`. */
    const failures: ChainFailure[] = [];
    let attempts = 0;
    // The attempt budget. At most two vendors per call — a third attempt is a
    // third bill for one page, and a vendor that fails twice in a row is not
    // going to be rescued by a fourth. With the team's own accounts tried
    // first, though, two bound accounts that both fail would spend the whole
    // budget before the platform tier, and the safety net would never be
    // reached. So the platform tier's first vendor is always reachable: up to
    // two bound attempts, then platform attempts up to one when any bound
    // attempt was made, two otherwise (a team with no bound vendor keeps
    // today's two platform attempts).
    //
    // A platform vendor that did no work does not spend the budget: one at its
    // own admission cap, or one that answered 429, was never billed and never
    // read the page. The tier has overflow rungs that exist for exactly that
    // moment (locus_exa behind the platform's rate-capped Exa), and a budget
    // that counted the refusal would end the call before reaching them.
    let boundAttempts = 0;
    let platformAttempts = 0;
    const refund = (tier: VendorTier | undefined) => {
      attempts--;
      if (tier === 'platform') platformAttempts--;
    };
    for (const v of chain) {
      const tier = opts?.tierOf?.(v);
      if (tier === undefined) {
        if (attempts >= 2) break;
      } else if (tier === 'bound') {
        if (boundAttempts >= 2) continue;
        boundAttempts++;
      } else {
        if (platformAttempts >= (boundAttempts > 0 ? 1 : 2)) break;
        platformAttempts++;
      }
      attempts++;

      // 1. Admission with cooperative wait + fair scheduling. By default we
      //    surface VendorPoolBusy to the caller (no chain escalation) because
      //    fast tools amortize the bounce. Deep research (30-60 min calls)
      //    pays an enormous cost for a bounced primary, so deepResearch opts
      //    into fallbackOnAdmissionBlock=true and we try the next chain entry
      //    instead of surfacing.
      //    A PLATFORM vendor at its cap is the one case that always falls
      //    through, at no cost to the budget: the platform tier is ordered so
      //    the vendor behind a rate-capped one is its overflow.
      let handle: InflightHandle;
      try {
        handle = await acquireInflightSlot(v, ctx.tenantId, ctx.agentId, ctx.toolName);
      } catch (e) {
        if (e instanceof VendorPoolBusy) {
          if (tier === 'platform' && v !== chain[chain.length - 1]) {
            lastErr = e;
            refund(tier);
            logger.info({ trace_id: ctx.traceId, vendor: v, retry_after_ms: e.retryAfterMs },
              'web_fetch_router platform_vendor_at_cap_overflowing');
            continue;
          }
          if (opts?.fallbackOnAdmissionBlock && v !== chain[chain.length - 1] && attempts < 2) {
            lastErr = e;
            logger.info({ trace_id: ctx.traceId, vendor: v, retry_after_ms: e.retryAfterMs },
              'web_fetch_router admission_block_falling_through');
            continue;
          }
          throw e;
        }
        throw e;
      }

      // 2. Vendor-side rate limit (token bucket) against the admitted vendor.
      //    Bucket exists ONLY to avoid the vendor sending us 429s. If we're at
      //    bucket capacity, we release the inflight slot and surface a soft
      //    retry signal — same shape as VendorPoolBusy, NOT a chain escalation.
      //
      //    A PLATFORM vendor out of budget OVERFLOWS to the rung behind it,
      //    at once and at no cost to the attempt budget — the same rule the
      //    concurrency cap above uses, for the same reason: the platform tier
      //    is ordered so the vendor behind a rate-capped one is its overflow.
      //    Perplexity leads the fetch, search and research chains and admits
      //    one call a second, so without this a run's reads would queue behind
      //    its own pacing while Exa, Locus and Tavily sat idle.
      //
      //    An empty bucket is worth WAITING for only when the chain has
      //    nowhere else to go — which is exactly the case for the tools
      //    Perplexity alone serves (finance and people search). There the wait
      //    is what makes the call succeed, so the budget is the caller's
      //    default rather than zero.
      const hasNextRung = v !== chain[chain.length - 1];
      const overflows = tier === 'platform' && hasNextRung;
      const fallbackOnBlock = Boolean(opts?.fallbackOnAdmissionBlock) && hasNextRung && attempts < 2;
      const willFallThrough = overflows || fallbackOnBlock;
      const rl = await consumeToken(ctx.tenantId, v, ctx.toolName, willFallThrough ? 0 : undefined);
      if (!rl.ok) {
        await handle.release().catch(() => {});
        const e = new VendorPoolBusy(v, rl.retryAfterMs ?? 1_000);
        if (willFallThrough) {
          lastErr = e;
          if (overflows) refund(tier);
          logger.info({ trace_id: ctx.traceId, vendor: v, retry_after_ms: e.retryAfterMs },
            'web_fetch_router token_bucket_falling_through');
          continue;
        }
        throw e;
      }

      // 3. Invoke. Slot released in finally regardless of success/failure.
      //    Chain escalation still happens on transient *invocation* failures
      //    (vendor errored mid-call), tracked via vendorHealthCache.
      try {
        const t0 = Date.now();
        const out = await invoke(v, handle);
        logger.info({
          trace_id: ctx.traceId, tenant_id: ctx.tenantId, agent_id: ctx.agentId,
          vendor: v, attempt: attempts, elapsed_ms: Date.now() - t0,
        }, 'web_fetch_router success');
        return out;
      } catch (err) {
        lastErr = err as Error;
        failures.push({ vendor: v, reason: boundedReason(err), error: err });
        if (this.isTransient(v, lastErr)) this.health.markFailed(v);
        if (tier === 'platform' && this.isRateLimited(v, lastErr)) refund(tier);
        logger.warn({ trace_id: ctx.traceId, vendor: v, error: lastErr.message }, 'web_fetch_router vendor failed');
      } finally {
        await handle.release().catch((err) => logger.warn({ err: (err as Error).message }, 'inflight release failed'));
      }
    }
    const classified = opts?.classifyExhaustion?.(failures) ?? null;
    if (classified) throw classified;
    throw lastErr ?? new Error('all web fetch backends failed');
  }

  /** The vendor refused on rate, so it did no work and was not billed.
   *
   *  Read off the status every vendor error class carries, not from a list of
   *  classes. The list named three of the thirteen, so the other ten spent an
   *  attempt from the platform budget on a call the vendor never performed. */
  private isRateLimited(_v: WebVendor, err: Error): boolean {
    return vendorRateLimit(err) !== null;
  }

  private isTransient(v: WebVendor, err: Error): boolean {
    if (err instanceof WebClawError)     return err.statusCode >= 500 || err.statusCode === 0;
    // 429 is NOT classified as transient at the router level — the token-bucket
    // layer surfaces rate limits as VendorPoolBusy, and VendorPoolBusy
    // deliberately does NOT escalate the chain. Vendor 5xx and network errors
    // still trip vendor health and fall through to the next vendor.
    if (err instanceof FirecrawlError)   return err.statusCode >= 500 || err.statusCode === 0;
    if (err instanceof PerplexityError) {
      // 408 = client-side deep_research ceiling (TR-5 DEEP_RESEARCH_TIMEOUT_STATUS).
      // 422 = response missing usage.cost.total_cost (TR-5 MISSING_COST_STATUS).
      // Both indicate Perplexity-server-is-fine, Liftoff-side problem. Marking
      // vendor health failed would block ALL Perplexity calls (including fast
      // fetch_url) for 60s. Surface as non-transient to the agent without
      // tripping VendorHealthCache.
      if (err.statusCode === 408 || err.statusCode === 422) return false;
      return err.statusCode >= 500 || err.statusCode === 0;
    }
    if (err instanceof AnchorError)      return err.statusCode >= 500 || err.statusCode === 0;
    if (err instanceof BrowserbaseError) return (err.statusCode ?? 0) >= 500;
    // 429 stays non-transient: it is Browser Use's CONCURRENT-session ceiling,
    // which clears when a sibling session stops rather than after a window, so
    // tripping vendor health would blank the vendor for 60s over a queue depth.
    if (err instanceof BrowserUseError)  return err.statusCode >= 500 || err.statusCode === 0;
    if (err instanceof SteelError)       return err.statusCode >= 500 || err.statusCode === 0;
    // The one vendor where 402 IS transient: it means the platform x402 wallet
    // could not pay (unfunded, per-call cap, daily ceiling), which no retry on
    // the next request changes. Marking the vendor failed for the health
    // window keeps the rung from paying a failed attempt on every call.
    if (err instanceof BrowserbaseX402Error) return err.statusCode >= 500 || err.statusCode === 0 || err.statusCode === 402;
    // Same for the Locus rung: a 402 is the platform's Locus balance, which no
    // retry on the next request changes.
    if (err instanceof LocusWebError)        return err.statusCode >= 500 || err.statusCode === 0 || err.statusCode === 402;
    if (err instanceof TavilyError)      return err.statusCode >= 500 || err.statusCode === 0;
    if (err instanceof ExaError) {
      // 422 = costDollars.total missing/invalid (MISSING_COST_STATUS). Same
      // sentinel logic as PerplexityError: it's a 4xx (non-transient) so
      // vendor health stays healthy, but the agent still sees a normal
      // failure. Don't mark vendor unhealthy on a billing-shape regression.
      if (err.statusCode === 422) return false;
      return err.statusCode >= 500 || err.statusCode === 0;
    }
    if (err instanceof OpenAIError) {
      // 408 (timeout) and 422 (missing usage) — non-transient, matches
      // Perplexity sentinel pattern. 429 NOT special-cased (matches existing
      // pattern — token bucket converts pre-call rate limits to
      // VendorPoolBusy; mid-call 429 surfaces non-transient).
      if (err.statusCode === 408 || err.statusCode === 422) return false;
      return err.statusCode >= 500 || err.statusCode === 0;
    }
    if (err instanceof GoogleError) {
      // budget_exceeded surfaces as 429 from GoogleClient — non-transient
      // (don't degrade vendor health for an account-level budget signal).
      // 408 timeout and 422 missing-usage non-transient like other vendors.
      if (err.statusCode === 408 || err.statusCode === 422 || err.statusCode === 429) return false;
      return err.statusCode >= 500 || err.statusCode === 0;
    }
    void v;
    return false;
  }

  private async lookupSessionVendor(sessionId: string, tenantId: string): Promise<WebVendor | null> {
    const r = await getPool().query(
      `SELECT vendor FROM web_sessions WHERE caller_session_id = $1 AND tenant_id = $2 AND closed_at IS NULL`,
      [sessionId, tenantId],
    );
    return r.rows[0]?.vendor ?? null;
  }
}

/**
 * Thin admission wrapper for single-vendor tools that don't go through
 * `runChain` (`web_session_save`, `web_identity_connect`, and also
 * `web_research`/`web_diff` which are direct-webclaw in current code).
 *
 * Same cooperative wait + fair scheduling as runChain; just no chain.
 * Closing a session (`web_session_close`) must NEVER call this — closes
 * release capacity and must not wait.
 */
export async function admitSingleVendor(
  vendor: WebVendor,
  ctx: { tenantId: string; agentId: string; toolName: string },
): Promise<{ release: () => Promise<void> } | { error: string; retryAfterMs: number; transient: true }> {
  let handle: InflightHandle;
  try {
    handle = await acquireInflightSlot(vendor, ctx.tenantId, ctx.agentId, ctx.toolName);
  } catch (e) {
    if (e instanceof VendorPoolBusy) {
      return {
        error: `Web tool busy. Retry in ~${Math.ceil(e.retryAfterMs / 1000)}s.`,
        retryAfterMs: e.retryAfterMs,
        transient: true,
      };
    }
    throw e;
  }
  const rl = await consumeToken(ctx.tenantId, vendor, ctx.toolName);
  if (!rl.ok) {
    await handle.release().catch(() => {});
    const retryAfterMs = rl.retryAfterMs ?? 1_000;
    return {
      error: `Web tool busy. Retry in ~${Math.ceil(retryAfterMs / 1000)}s.`,
      retryAfterMs,
      transient: true,
    };
  }
  return { release: () => handle.release() };
}
