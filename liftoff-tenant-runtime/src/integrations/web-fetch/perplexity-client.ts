// Perplexity vendor client. Implements the WebFetchAdvancedClient contract
// for fetch + research + the three Perplexity-only primitives
// (people_search, finance_search, deep_research).
//
// Endpoint paths verified at code-time against https://docs.perplexity.ai/
// (June 2026). Per TR-5's "API contract caveat" escape clause, deviations
// from the plan's best-guess `/tools/*` paths are confined to this file:
//   - fetch():         POST /v1/agent  tools=[{type:'fetch_url', max_urls:1}]
//   - search():        POST /search                                (no /v1)
//   - research():      POST /v1/agent  tools=[{type:'web_search'}]
//   - peopleSearch():  POST /v1/agent  tools=[{type:'people_search'}]
//   - financeSearch(): POST /v1/agent  tools=[{type:'finance_search'}]
//   - deepResearch():  POST /async/chat/completions                (+ poll GET, NO /v1 prefix)
//
// extract() is intentionally NOT implemented — Perplexity exposes no
// dedicated schema-guided extraction primitive (see TR-5 escape clause +
// the router.extract chain note that omits perplexity).
//
// Cost model (per OU billing requirement — every call's micro-cost must be
// exact, never approximated):
//   - Agent API responses include `usage.cost.total_cost` in USD aggregating
//     LLM + tool call cost. We read that field directly. Missing cost field
//     is a hard contract break — throw PerplexityError(422) so the cost is
//     never silently $0 (would under-bill the operating-unit ledger).
//   - /search has a published flat-rate contract price ($5 per 1,000 requests
//     → exactly $0.005 per call). Hardcoded as a constant because the response
//     itself returns no cost field — this is the contract price, not an
//     approximation. It backs `web_search`, the BASIC search, and nothing
//     else: it used to back `web_research`, which describes a synthesized,
//     cited answer, and ranked snippets under that name taught every model
//     that the platform's research tool was a heavy one to hold in reserve.
//   - research() is the Agent API's own `web_search` tool: several sources
//     read, one cited answer written ($2.50 per 1,000 invocations plus the
//     tokens, docs.perplexity.ai/docs/agent-api/tools/web-search, read
//     2026-09-15). Cost is read from `usage.cost.total_cost` like every other
//     Agent API call here.
//   - deepResearch reads usage.cost.total_cost from the completed async chat
//     completions response, same as Agent API. The token+search breakdown is
//     still recorded as descriptive metadata, but never used to compute cost.

import { randomUUID } from 'node:crypto';
import { logger } from '../../infrastructure/logging';
import { getWebToolSecret } from './web-tool-secrets';
import { getCachedSentinelFlags } from './limits-config';
import { parseRateLimitHeaders } from './credential-pool';
import { retryAfterFromSnapshot } from './vendor-rate-limit';
import {
  insertSubmission,
  finalizeSubmission,
  markPolled,
  markHookActive,
} from './deep-research-registry';
import type {
  WebFetchAdvancedClient,
  WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
  WebResearchRequest, InternalWebResearchResult,
  WebSearchRequest, InternalWebSearchResult,
  WebPeopleSearchRequest, InternalWebPeopleSearchResult,
  WebFinanceSearchRequest, InternalWebFinanceSearchResult,
  WebDeepResearchRequest, InternalWebDeepResearchResult,
  WebVendor,
} from './types';

const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';
const PERPLEXITY_TIMEOUT_MS = 30_000;
// Agent API requires provider-prefixed model IDs per GET /v1/models
// (June 2026). The bare `sonar` works for chat completions but is rejected
// by the Agent API with HTTP 400 "model not supported".
const PERPLEXITY_AGENT_MODEL = 'perplexity/sonar';

// Per Perplexity public pricing (verified June 2026): the Search API is flat
// $5 per 1,000 requests with NO token-based pricing. The /search response
// returns no cost field, so we record this contract price directly. This is
// the exact billed amount, not an approximation.
const USD_PER_SEARCH_REQUEST = 0.005;

// Deep research poll loop.
//
// Real-world observed completion times for `/async/chat/completions` +
// `sonar-deep-research` cluster around 20-40 minutes per several public
// forum reports (Perplexity Community: "Sonar-deep-research taking longer
// than expected", "Sonar Deep Research async mode and reasoning effort").
// Perplexity does NOT document a server-side TTL and there is no cancel
// endpoint, so a client-side ceiling is still needed as a circuit-breaker
// against the documented "stuck IN_PROGRESS for hours" bug pattern. 45
// minutes covers the real completion window with buffer while bailing on
// the multi-hour pathology. Callers can extend further via maxWaitMs.
//
// Bumped to 60 min to accommodate Google Gemini deep-research's 60-min ceiling
// (D15 in the 4-tier deep-research plan). Perplexity itself still typically
// finishes inside 45 min; the wider ceiling only matters for the Google
// vendor + governs the concurrency-limits.ts boot invariant.
export const DEEP_RESEARCH_MAX_WAIT_MS = 60 * 60 * 1000;
const DEEP_RESEARCH_POLL_INTERVAL_MS = 5000;

// Sentinel HTTP status used internally for the poll-loop timeout. 408
// (Request Timeout) is deliberately chosen over 0 (network error) because
// router.isTransient classifies 0/5xx as transient and marks vendor health
// failed — which would block ALL Perplexity calls (including fast fetch_url)
// for 60s every time deep_research times out. 408 is excluded from
// isTransient (see TR-7h) so the handler returns non-transient to the agent
// and vendor health stays healthy.
const DEEP_RESEARCH_TIMEOUT_STATUS = 408;

// Sentinel for "response missing required usage.cost.total_cost" — chosen 422
// (Unprocessable Entity) because it's a 4xx (not classified as transient by
// router.isTransient, so vendor health stays healthy) and semantically
// signals the response body was unprocessable from our perspective. Surfacing
// as non-transient is intentional: a missing cost field is a contract break
// that operators need to see, not a vendor health blip to silently retry.
const MISSING_COST_STATUS = 422;

export class PerplexityError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: unknown,
    /** What the response asked us to wait, when it said. The vendor sends
     *  `retry-after: 1` with every Agent-API 429 and this used to be read and
     *  discarded with the rest of the headers. */
    public readonly retryAfterMs?: number,
  ) {
    super(message); this.name = 'PerplexityError';
  }
}

const DEEP_RESEARCH_PRECHARGE_DEFAULT_USD: Record<'low' | 'medium' | 'high', number> = {
  low: 0.15, medium: 0.40, high: 0.75,
};

async function readPrechargeEstimateMicros(effort: 'low' | 'medium' | 'high'): Promise<number> {
  const flags = await getCachedSentinelFlags();
  const key = `web_deep_research_precharge_${effort}_micros_value`;
  const override = flags[key];
  if (typeof override === 'number' && override > 0) return override;
  return Math.round(DEEP_RESEARCH_PRECHARGE_DEFAULT_USD[effort] * 1_000_000);
}

export interface DeepResearchPreCharge {
  deepResearchId: string;
  vendor: WebVendor;
  reasoningEffort: 'low' | 'medium' | 'high';
  estimateCostMicros: number;
  submittedAt: Date;
  submissionId: string;
}

export interface DeepResearchCompletionDelta {
  deepResearchId: string;
  vendor: WebVendor;
  actualCostMicros: number;
  estimateCostMicros: number;
  deltaCostMicros: number;
  status: 'COMPLETED' | 'FAILED';
  submissionId: string;
}

export interface DeepResearchHooks {
  onPreCharge?:  (p: DeepResearchPreCharge) => Promise<void>;
  onCompletion?: (d: DeepResearchCompletionDelta) => Promise<void>;
  onHeartbeat?:  () => Promise<{ refreshed: boolean }>;
}

// Plan-aliased name for AsyncChatResponse.response so the deepResearch body
// matches the plan's inline shape verbatim.
type PerplexityChatCompletion = NonNullable<AsyncChatResponse['response']>;

// ── Agent API response shapes ────────────────────────────────────────────────
// `/v1/agent` returns a discriminated union of output items. We unwrap the
// specific tool result by walking `output[]` for the matching item type.

// Agent API response shapes verified against live /v1/agent (June 2026).
// Each output item discriminator is `type: "<name>"`; the actual data is in
// `contents` (fetch_url) or `results` (people/finance) — NOT in a field
// matching the discriminator. Earlier docs were misleading.
interface AgentOutputItemFetchUrl {
  type: 'fetch_url_results';
  contents?: Array<{ url: string; snippet?: string; title?: string }>;
}
interface AgentOutputItemPeople {
  type: 'people_search_results';
  queries?: string[];
  results?: Array<{
    id?: number;
    title?: string;        // page title (often "Name | Role | Company")
    url?: string;          // canonical URL
    snippet?: string;      // free-form markdown describing the person
    source?: string;       // 'web' | 'linkedin' | etc.
    last_updated?: string;
  }>;
}
interface AgentOutputItemFinance {
  type: 'finance_results';
  categories?: string[];   // e.g. ['quote', 'news']
  tickers?: string[];      // ticker symbols
  results?: Array<{
    category?: string;     // 'quote' | 'news' | etc.
    content?: string;      // markdown table dump (quote) or article (news)
    sources?: string[];    // URLs
    tickers?: string[];
  }>;
}
interface AgentOutputItemMessage {
  type: 'message';
  /** A string on the live API as probed in June 2026; the current reference
   *  documents an array of `output_text` parts. Both are read. */
  content?: string | Array<{ type?: string; text?: string }>;
}
interface AgentOutputItemSearchResults {
  type: 'search_results';
  queries?: string[];
  results?: Array<{ id?: number; url?: string; title?: string; snippet?: string; date?: string; source?: string }>;
}
type AgentOutputItem =
  | AgentOutputItemFetchUrl
  | AgentOutputItemPeople
  | AgentOutputItemFinance
  | AgentOutputItemMessage
  | AgentOutputItemSearchResults
  | { type: string };

/** Perplexity's `fetch_url` placeholder for a page that yielded nothing:
 *  `[fetch_url: no content could be retrieved for <url> — no_result_returned.
 *  …]`. The bracketed `fetch_url:` prefix and the vendor's own outcome code
 *  are the shape; the prose between them is the vendor's and may change. */
const FETCH_URL_NO_RESULT = /^\s*\[fetch_url:[^\]]*\bno_result_returned\b/i;

/** True when a `fetch_url` snippet is the vendor's no-result placeholder
 *  rather than the page. */
export function isFetchUrlNoResult(snippet: string): boolean {
  return FETCH_URL_NO_RESULT.test(snippet);
}

/** The assistant's text from a `message` item, whichever shape it arrived in. */
function messageText(item: AgentOutputItemMessage | undefined): string {
  const c = item?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(p => p.type === 'output_text' || p.text).map(p => p.text ?? '').join('');
  return '';
}

// Perplexity Agent API + chat-completions usage block. `cost.total_cost` is
// the aggregated USD spend for the call (LLM tokens + tool calls + caching).
export interface PerplexityUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  // chat-completions sync/async shape uses prompt_tokens/completion_tokens
  prompt_tokens?: number;
  completion_tokens?: number;
  citation_tokens?: number;
  reasoning_tokens?: number;
  num_search_queries?: number;
  search_context_size?: number;
  cost?: {
    currency?: 'USD' | string;
    input_cost?: number;
    output_cost?: number;
    cache_creation_cost?: number;
    cache_read_cost?: number;
    tool_calls_cost?: number;
    total_cost?: number;
  };
}

interface AgentResponse {
  output: AgentOutputItem[];
  usage?: PerplexityUsage;
}

interface SearchApiResponse {
  results?: Array<{ url: string; title?: string; snippet?: string; date?: string }>;
}

interface AsyncChatResponse {
  status: 'CREATED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | string;
  response: {
    choices: Array<{ message: { content: string } }>;
    search_results?: Array<{ url: string; title?: string; date?: string }>;
    usage: PerplexityUsage;
  } | null;
  error_message?: string | null;
}

/**
 * Extracts the exact billed USD cost from a Perplexity response and converts
 * to micros. This is the cost Perplexity actually charged us — never an
 * approximation, never a fixed constant on the Agent API / chat-completions
 * paths. The downstream OU ledger derives operating units from this exact
 * micro-cost, so any drift here propagates into incorrect customer billing.
 *
 * The Perplexity API contract (verified June 2026 against the OpenAPI spec)
 * guarantees `usage.cost.total_cost` is present and USD on every successful
 * Agent API + chat-completions response. We enforce that contract here:
 *
 *   - Missing field      → throw 422 (router treats as healthy non-transient;
 *                          surfaces to operators as a contract break, never
 *                          silently records $0)
 *   - Non-number type    → throw 422 (defensive against shape drift)
 *   - Negative number    → throw 422 (defensive; Perplexity should never
 *                          report a negative spend)
 *   - Non-USD currency   → throw 422 (defensive against future multi-currency
 *                          rollout; the OU conversion assumes USD)
 *
 * Zero is allowed — Perplexity may legitimately report $0 (e.g. cache hit on
 * a free tier). The handler will record a $0 cost-attribution event, which
 * is correct: the customer wasn't charged either.
 *
 * The /search path does NOT use this helper. Search API returns no cost
 * field because pricing is a flat $5/1000 requests with no token component;
 * the constant USD_PER_SEARCH_REQUEST is the exact contract price (not an
 * approximation, not an estimate — it is the per-call billed amount).
 */
export function exactCostMicros(usage: PerplexityUsage | undefined, context: string): number {
  const cost = usage?.cost;
  const total = cost?.total_cost;
  if (typeof total !== 'number') {
    throw new PerplexityError(
      `Perplexity response missing usage.cost.total_cost (${context}) — cannot bill OU ledger without exact cost`,
      MISSING_COST_STATUS,
    );
  }
  if (total < 0) {
    throw new PerplexityError(
      `Perplexity reported negative total_cost=${total} (${context}) — refusing to bill OU ledger`,
      MISSING_COST_STATUS,
    );
  }
  if (cost?.currency != null && cost.currency !== 'USD') {
    throw new PerplexityError(
      `Perplexity reported non-USD currency='${cost.currency}' (${context}) — OU conversion assumes USD`,
      MISSING_COST_STATUS,
    );
  }
  return Math.round(total * 1_000_000);
}

export class PerplexityClient implements WebFetchAdvancedClient {
  readonly vendor = 'perplexity' as const;
  private apiKey: string | null = null;

  supportsSessions(): boolean { return false; }

  private async key(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    const k = await getWebToolSecret('perplexity-api-key');
    if (!k) throw new Error('perplexity-api-key not configured');
    this.apiKey = k;
    return k;
  }

  async fetch(req: WebFetchAdvancedRequest): Promise<InternalWebFetchAdvancedResult> {
    if (req.sessionId) throw new Error('Perplexity does not support sessions');
    const body = await this.call<AgentResponse>('/v1/agent', {
      input: `Fetch the full text content of the URL: ${req.url}`,
      model: PERPLEXITY_AGENT_MODEL,
      tools: [{ type: 'fetch_url', max_urls: 1 }],
    });
    const fetchItem = body.output.find((o): o is AgentOutputItemFetchUrl => o.type === 'fetch_url_results');
    const hit = fetchItem?.contents?.[0];
    const content = hit?.snippet ?? '';
    if (content.length === 0) {
      throw new PerplexityError('Empty content from Perplexity fetch_url (likely antibot block)', 200);
    }
    // The vendor's OTHER way of saying the page yielded nothing. For an
    // address the origin answers with no content (a real 404), `fetch_url`
    // does not return an empty snippet: it returns a bracketed placeholder
    // naming its own `no_result_returned` outcome. Read as content, that
    // placeholder was handed to the model as the page, and the call counted
    // as a success — so the one vendor that leads the non-JS chain could
    // never report a missing page as missing. Same class as the empty answer:
    // the vendor answered, the page gave nothing, status 200.
    if (isFetchUrlNoResult(content)) {
      throw new PerplexityError('Perplexity fetch_url returned no result for the page (no_result_returned)', 200);
    }
    return {
      content,
      finalUrl: hit?.url ?? req.url,
      sessionId: undefined,
      vendor: 'perplexity',
      costMicros: exactCostMicros(body.usage, 'fetch_url'),
      jsRendered: false,  // fetch_url is not a headless browser
    };
  }

  // extract() is deliberately NOT implemented. Perplexity has no schema-guided
  // extraction primitive equivalent to firecrawl /v2/scrape json. The
  // WebFetchAdvancedClient `extract?` is optional; router.ts:extract() omits
  // perplexity from the chain so the missing method is never invoked.

  /** The BASIC search: ranked results, flat price, no synthesis. */
  async search(req: WebSearchRequest): Promise<InternalWebSearchResult> {
    // POST /search (NOT /v1/search). Search API is flat $5/1000 requests, no
    // token cost, no cost field in the response. USD_PER_SEARCH_REQUEST is the
    // exact contract price (per https://docs.perplexity.ai/ pricing as of
    // June 2026), not an approximation.
    const max = req.maxResults ?? 10;
    const body = await this.call<SearchApiResponse>('/search', {
      query: req.query,
      max_results: Math.max(1, Math.min(max, 20)),  // /search caps at 20
    });
    const hits = body.results ?? [];
    return {
      results: hits.map(r => ({ url: r.url, title: r.title ?? r.url, snippet: r.snippet, date: r.date })),
      vendor: 'perplexity',
      costMicros: Math.round(USD_PER_SEARCH_REQUEST * 1_000_000),
    };
  }

  /** The ADVANCED tier: several sources read, one cited answer written, by
   *  the Agent API's own web_search tool. */
  async research(req: WebResearchRequest): Promise<InternalWebResearchResult> {
    const max = req.maxSources ?? 10;
    const body = await this.call<AgentResponse>('/v1/agent', {
      input: req.outputSchema
        ? `Research the following and answer it as JSON matching this schema: ${JSON.stringify(req.outputSchema)}\n\nQuestion: ${req.question}`
        : `Research the following across several sources and answer it, citing the sources you used.\n\nQuestion: ${req.question}`,
      model: PERPLEXITY_AGENT_MODEL,
      tools: [{ type: 'web_search', max_results: Math.max(1, Math.min(max, 50)) }],
    });
    const message = body.output.find((o): o is AgentOutputItemMessage => o.type === 'message');
    const searchItem = body.output.find((o): o is AgentOutputItemSearchResults => o.type === 'search_results');
    const text = messageText(message);
    let answer: string | unknown = text;
    if (req.outputSchema) {
      try { answer = JSON.parse(text); } catch { answer = text; }
    }
    const seen = new Set<string>();
    const sources: InternalWebResearchResult['sources'] = [];
    for (const r of searchItem?.results ?? []) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      sources.push({ url: r.url, title: r.title ?? r.url, snippet: r.snippet });
    }
    return {
      answer,
      sources,
      vendor: 'perplexity',
      costMicros: exactCostMicros(body.usage, 'web_search'),
    };
  }

  async peopleSearch(req: WebPeopleSearchRequest): Promise<InternalWebPeopleSearchResult> {
    const max = req.maxSources ?? 10;
    const filterClause = req.filters
      ? ` Filters: ${[
          req.filters.company  ? `company=${req.filters.company}`   : '',
          req.filters.title    ? `title=${req.filters.title}`       : '',
          req.filters.location ? `location=${req.filters.location}` : '',
        ].filter(Boolean).join(', ')}.`
      : '';
    const body = await this.call<AgentResponse>('/v1/agent', {
      input: `${req.query}.${filterClause} Return up to ${max} people.`,
      model: PERPLEXITY_AGENT_MODEL,
      tools: [{ type: 'people_search' }],
    });
    const item = body.output.find((o): o is AgentOutputItemPeople => o.type === 'people_search_results');
    // Perplexity's people_search returns search-result-style records (title,
    // url, free-form snippet) rather than structured {name, company,
    // location} fields. We surface the page title as `name`, the markdown
    // snippet as `title` (the most informative free-text), and keep `company`/
    // `location` undefined so agents read the snippet for structured info.
    const results = (item?.results ?? []).map(p => ({
      name:     p.title ?? '',
      title:    p.snippet,
      company:  undefined,
      location: undefined,
      sources:  p.url ? [p.url] : [],
    }));
    return {
      results,
      vendor: 'perplexity',
      costMicros: exactCostMicros(body.usage, 'people_search'),
    };
  }

  async financeSearch(req: WebFinanceSearchRequest): Promise<InternalWebFinanceSearchResult> {
    const max = req.maxSources ?? 10;
    const instrumentClause = req.instrument ? ` Instrument: ${req.instrument}.` : '';
    const body = await this.call<AgentResponse>('/v1/agent', {
      input: `${req.query}.${instrumentClause} Return up to ${max} results.`,
      model: PERPLEXITY_AGENT_MODEL,
      tools: [{ type: 'finance_search' }],
    });
    const item = body.output.find((o): o is AgentOutputItemFinance => o.type === 'finance_results');
    // Perplexity's finance_search returns category-grouped results whose
    // `content` is a markdown table dump (for quotes) or article body (for
    // news). Surface tickers via `tickers[0]`, category as `instrument`, and
    // the content as `summary`.
    const results = (item?.results ?? []).map(f => ({
      ticker:     f.tickers?.[0],
      instrument: f.category ?? '',
      summary:    f.content ?? '',
      sources:    f.sources ?? [],
    }));
    return {
      results,
      vendor: 'perplexity',
      costMicros: exactCostMicros(body.usage, 'finance_search'),
    };
  }

  async deepResearch(
    req: WebDeepResearchRequest,
    hooks?: DeepResearchHooks,
  ): Promise<InternalWebDeepResearchResult> {
    const startMs        = Date.now();
    const maxWaitMs      = req.maxWaitMs ?? DEEP_RESEARCH_MAX_WAIT_MS;
    // D21: WebDeepResearchRequest.reasoningEffort now includes 'highest'
    // for Google/OpenAI; Perplexity's API only accepts low/medium/high. The
    // router coerces 'highest' → 'high' before dispatch, but we also narrow
    // here defensively so direct callers (tests, future code) can't smuggle
    // 'highest' into Perplexity.
    const rawReasoning   = req.reasoningEffort ?? 'medium';
    const reasoning: 'low' | 'medium' | 'high' =
      rawReasoning === 'highest' ? 'high' : rawReasoning;
    const deepResearchId = randomUUID();

    // 1. Submit async deep_research request to Perplexity. /async/chat/completions
    //    (verified live: NO /v1 prefix for chat-completions, unlike /v1/agent).
    const submission = await this.call<{ id: string }>('/async/chat/completions', {
      request: {
        model:            'sonar-deep-research',
        messages:         [{ role: 'user', content: req.question }],
        reasoning_effort: reasoning,
      },
    });

    // 2. Compute estimate (shared between registry write + pre-charge hook).
    const estimateCostMicros = await readPrechargeEstimateMicros(reasoning);

    // 3. Write the submissions-registry row BEFORE firing the pre-charge
    //    hook. The reconciler (deep-research-reconciler.ts) drives off this
    //    row to recover from hook failures (Pub/Sub drop, process crash,
    //    408 ceiling). Failure to write degrades us to hook-only
    //    correctness (i.e. the pre-fix state) — log ERROR but continue;
    //    the call itself is not aborted.
    if (req.tenantId) {
      try {
        await insertSubmission({
          deepResearchId,
          submissionId:       submission.id,
          tenantId:           req.tenantId,
          agentId:            req.agentId ?? null,
          vendor:             'perplexity',
          reasoningEffort:    reasoning,
          estimateCostMicros,
        });
      } catch (err) {
        logger.error({
          err: (err as Error).message,
          deep_research_id: deepResearchId,
          submission_id:    submission.id,
        }, 'deep_research_registry_write_lost');
      }
    } else {
      // tenantId is plumbed through the router (TR-6). A missing tenantId
      // means the call originated outside the router — abort registry,
      // accept hook-only correctness for this call. Should be impossible
      // in production but is harmless if it happens.
      logger.warn({
        deep_research_id: deepResearchId,
        submission_id:    submission.id,
      }, 'deep_research_registry_skipped_no_tenant');
    }

    // 4. Fire pre-charge hook. Fire-and-forget — caller wraps in withRetry,
    //    failures log deep_research_precharge_lost at ERROR. The registry
    //    row above ensures the reconciler picks this up regardless.
    if (hooks?.onPreCharge) {
      hooks.onPreCharge({
        deepResearchId,
        vendor:             'perplexity',
        reasoningEffort:    reasoning,
        estimateCostMicros,
        submittedAt:        new Date(),
        submissionId:       submission.id,
      }).catch(err => logger.error({
        err:                  (err as Error).message,
        deep_research_id:     deepResearchId,
        submission_id:        submission.id,
        estimate_cost_micros: estimateCostMicros,
      }, 'deep_research_precharge_lost'));
    }

    // 5. Poll loop with heartbeat (Phase 1).
    const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
    let   lastHeartbeatMs       = startMs;
    let   consecutiveHeartbeatFailures = 0;
    let   final: { status: string; response?: PerplexityChatCompletion; error_message?: string } | null = null;

    while (Date.now() - startMs < maxWaitMs) {
      await new Promise(r => setTimeout(r, DEEP_RESEARCH_POLL_INTERVAL_MS));

      // Registry hook heartbeat (Gap #5): every poll iteration, push
      // hook_active_until forward by 30s so the reconciler defers to us.
      // Fire-and-forget — a DB blip won't kill the call; worst case the
      // reconciler picks up the row, double-polls Perplexity (cheap),
      // and PB dedupes the emit.
      if (req.tenantId) {
        markHookActive(deepResearchId, 30).catch((err: Error) => logger.warn({
          err: err.message, deep_research_id: deepResearchId,
        }, 'deep_research_hook_heartbeat_failed'));
      }

      // Inflight-row heartbeat (Phase 1): every 4 min, refresh the
      // concurrency-limits inflight-row TTL via the runChain handle.
      if (hooks?.onHeartbeat && Date.now() - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
        try {
          const { refreshed } = await hooks.onHeartbeat();
          consecutiveHeartbeatFailures = 0;
          lastHeartbeatMs              = Date.now();
          if (!refreshed) {
            logger.warn({ deep_research_id: deepResearchId, submission_id: submission.id },
              'deep_research_inflight_row_missing');
          }
        } catch (err) {
          consecutiveHeartbeatFailures++;
          if (consecutiveHeartbeatFailures >= 3) {
            logger.error({
              err: (err as Error).message,
              deep_research_id: deepResearchId,
              consecutive_failures: consecutiveHeartbeatFailures,
            }, 'deep_research_heartbeat_stuck');
          }
        }
      }

      // Poll: GET /async/chat/completions/{id}.
      const status = await this.call<{
        status:        string;
        response?:     PerplexityChatCompletion;
        error_message?: string;
      }>(`/async/chat/completions/${submission.id}`, undefined, 'GET');

      if (status.status === 'COMPLETED' || status.status === 'FAILED') {
        final = status;
        break;
      }
    }

    // 6. 408 ceiling. NO onCompletion event — upstream is still running and
    //    will bill us. The reconciler (deep-research-reconciler.ts) picks up
    //    the registry row at next cycle and re-polls Perplexity; whenever
    //    Perplexity finally returns COMPLETED, the reconciler emits the
    //    proper delta. After 24h still IN_PROGRESS the reconciler marks
    //    abandoned and emits a refund.
    //
    //    markPolled here pushes last_polled_at forward so the reconciler
    //    waits the full adaptive interval before re-polling Perplexity
    //    (we polled at the very end of our 45min ceiling — Perplexity
    //    isn't going to flip in the next 60s with overwhelming probability).
    if (!final) {
      if (req.tenantId) {
        markPolled(deepResearchId).catch((err: Error) => logger.warn({
          err: err.message, deep_research_id: deepResearchId,
        }, 'deep_research_markpolled_failed'));
      }
      throw new PerplexityError(
        `deep_research exceeded ${maxWaitMs}ms ceiling (request ${submission.id} still running upstream)`,
        DEEP_RESEARCH_TIMEOUT_STATUS,
      );
    }

    // 7. FAILED: emit a delta finalizing the registry, then throw.
    //
    // Gap #3 — partial cost extraction. Perplexity's pricing is component-
    // based; a call that runs partway through (some search queries +
    // reasoning tokens) and then fails likely still bills us. If the FAILED
    // response carries usage.cost.total_cost, that is the partial bill —
    // use it. Otherwise refund the full estimate (FAILED before any spend).
    //
    // Gap #4 — COMPLETED + null response handling. If Perplexity says
    // COMPLETED but response is null, treat it as FAILED here (the predicate
    // `!final.response` catches both 'FAILED' status and null-response).
    if (final.status === 'FAILED' || !final.response) {
      let actualCostMicros = 0;
      try {
        // exactCostMicros throws if usage.cost.total_cost is missing or
        // malformed. On FAILED, that's the expected path (no usage block).
        // On COMPLETED-with-null-response, also expected. Catch and refund
        // full estimate; only if Perplexity explicitly reports a partial
        // cost do we use it.
        if (final.response?.usage) {
          actualCostMicros = exactCostMicros(final.response.usage, 'deep_research_failed_partial');
        }
      } catch {
        actualCostMicros = 0;
      }
      const deltaCostMicros = actualCostMicros - estimateCostMicros;
      if (hooks?.onCompletion) {
        hooks.onCompletion({
          deepResearchId,
          vendor:              'perplexity',
          actualCostMicros,
          estimateCostMicros,
          deltaCostMicros,
          status:              'FAILED',
          submissionId:        submission.id,
        }).catch(err => logger.error({
          err: (err as Error).message, deep_research_id: deepResearchId,
        }, 'deep_research_delta_lost'));
      }
      if (req.tenantId) {
        finalizeSubmission({
          deepResearchId,
          finalStatus:     'failed',
          finalCostMicros: actualCostMicros,
        }).catch((err: Error) => logger.error({
          err: err.message, deep_research_id: deepResearchId,
        }, 'deep_research_registry_finalize_lost'));
      }
      throw new PerplexityError(
        `deep_research failed: ${final.error_message ?? (final.response ? 'unknown' : 'response was null')}`,
        500,
        final.error_message,
      );
    }

    // 8. COMPLETED: emit signed delta (= actual - estimate), finalize the
    //    registry row. May be positive (under-estimate; ingester debits the
    //    difference) or negative (over-estimate; PB-3 routes via
    //    applyOuRefund). Finalize is idempotent — reconciler race-safe.
    const completion       = final.response;
    const actualCostMicros = exactCostMicros(completion.usage, 'deep_research');
    if (hooks?.onCompletion) {
      hooks.onCompletion({
        deepResearchId,
        vendor:           'perplexity',
        actualCostMicros,
        estimateCostMicros,
        deltaCostMicros:  actualCostMicros - estimateCostMicros,
        status:           'COMPLETED',
        submissionId:     submission.id,
      }).catch(err => logger.error({
        err: (err as Error).message, deep_research_id: deepResearchId,
      }, 'deep_research_delta_lost'));
    }
    if (req.tenantId) {
      finalizeSubmission({
        deepResearchId,
        finalStatus:     'completed',
        finalCostMicros: actualCostMicros,
      }).catch((err: Error) => logger.error({
        err: err.message, deep_research_id: deepResearchId,
      }, 'deep_research_registry_finalize_lost'));
    }

    return {
      report:         completion.choices[0]?.message.content ?? '',
      sources:        completion.search_results ?? [],
      vendor:         'perplexity',
      costMicros:     actualCostMicros,
      deepResearchId,
      usage: {
        prompt_tokens:        completion.usage.prompt_tokens       ?? 0,
        completion_tokens:    completion.usage.completion_tokens   ?? 0,
        citation_tokens:      completion.usage.citation_tokens     ?? 0,
        reasoning_tokens:     completion.usage.reasoning_tokens    ?? 0,
        num_search_queries:   completion.usage.num_search_queries  ?? 0,
        search_context_size:  completion.usage.search_context_size,  // verified at types.ts:310 — optional field
      },
      durationMs: Date.now() - startMs,
    };
  }

  protected async call<T>(path: string, body: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
    const apiKey = await this.key();
    let res: Response;
    try {
      res = await fetch(`${PERPLEXITY_BASE_URL}${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' && body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(PERPLEXITY_TIMEOUT_MS),
      });
    } catch (e) {
      throw new PerplexityError(`Network: ${(e as Error).message}`, 0);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PerplexityError(
        `Perplexity ${res.status}: ${text}`,
        res.status,
        text,
        retryAfterFromSnapshot(parseRateLimitHeaders(res.headers)),
      );
    }
    return res.json() as Promise<T>;
  }
}

// Reference logger to keep import non-empty in environments where it's unused.
void logger;
