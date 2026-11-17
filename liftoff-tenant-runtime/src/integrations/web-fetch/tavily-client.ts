// Tavily vendor client. Implements the WebFetchAdvancedClient contract for
// fetch + research. extract() is intentionally NOT implemented — Tavily's
// /extract returns raw text with no schema-guided extraction primitive.
// router.ts:extract() chain omits 'tavily' (same as 'perplexity').
//
// Endpoint paths + payload shapes verified by live curl (see
// plan §0). Field names below are not speculative — they reflect the actual
// HTTP responses observed against api.tavily.com.
//   fetch():    POST /extract  body: { urls, extract_depth, include_usage }
//   research(): POST /search   body: { query, search_depth, max_results,
//                                       include_answer, include_usage }
//
// Cost model:
//   - Pay-as-you-go: $0.008/credit (chosen because it scales to zero — no
//     fixed monthly fee). First 1,000 credits/mo are still free under the
//     Researcher allotment; paygo only kicks in once that's exhausted.
//   - Monthly plans (Project/Bootstrap/Startup/Growth) drop the rate to
//     $0.0075 → $0.005 per credit but commit fixed monthly spend.
//   - /search basic = 1 credit (verified live); /search advanced = 2 credits.
//   - /extract basic = 1 credit per 5 URLs; advanced = 2 credits per 5.
//     We only ever extract 1 URL per call → 0.2 credits per /extract.
//   - Tavily responses always include a `usage.credits` number when we pass
//     `include_usage: true`. We always pass it. No fallback math needed.

import { logger } from '../../infrastructure/logging';
import type { CredentialScope } from './credential-scope';
import { getWebToolCredential, getWebToolSecret, VendorNotConnected } from './web-tool-secrets';
import { BYOKVendorError, type VendorErrorCode, type WebToolFunding } from './types';
import { buildByokErrorMessage, markConnectorErrored } from './byok-error-handler';
import { observeVendorResponse } from './credential-pool';
import type {
  WebFetchAdvancedClient,
  WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
  WebResearchRequest, InternalWebResearchResult,
} from './types';

const TAVILY_BASE_URL = 'https://api.tavily.com';
const TAVILY_TIMEOUT_MS = 30_000;

// Pay-as-you-go marginal rate: $0.008 per credit. Treating every credit as
// $0.008 produces accurate per-call attribution above the 1,000-credit
// Researcher free allotment.
const USD_PER_CREDIT = 0.008;

// Tavily search_depth='basic' caps at 20 results.
const MAX_RESULTS_CEILING = 20;

interface TavilyUsage {
  credits: number;
}

interface TavilyExtractResponse {
  results: Array<{
    url: string;
    title?: string;
    raw_content: string;
    images?: string[];
  }>;
  failed_results: Array<{ url: string; error: string }>;
  response_time: number;
  usage: TavilyUsage;
  request_id: string;
}

interface TavilySearchResponse {
  query: string;
  follow_up_questions: string[] | null;
  answer: string | null;
  images: string[];
  results: Array<{
    url: string;
    title?: string;
    content: string;
    score: number;
    raw_content: string | null;
  }>;
  response_time: number;
  usage: TavilyUsage;
  request_id: string;
}

export class TavilyError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly body?: unknown) {
    super(message); this.name = 'TavilyError';
  }
}

/** A router-bound request: the tenant, and which of its connectors may serve
 *  (credential-scope.ts). The scope is required so the compiler refuses a call
 *  that has not decided it. */
type WithTenant<T> = T & { tenantId: string; credentialScope: CredentialScope };

export class TavilyClient implements WebFetchAdvancedClient {
  readonly vendor = 'tavily' as const;

  supportsSessions(): boolean { return false; }

  /** Whose account pays for this call, decided in exactly one place.
   *
   *  A team bound to the workspace's own tavily connector uses that key and
   *  is billed by the vendor directly. A team bound to nothing gets the
   *  platform's pay-as-you-go key, and the call is metered against its
   *  Operating Units at the vendor's real charge (funding 'platform'). The
   *  connector id is the carrier: a tenant credential has one, the platform
   *  key does not, and null is the whole signal. A COOLING tenant key is
   *  deliberately NOT failed over to the platform key (VendorConnectorErrored
   *  propagates); only "no connector at all" falls back. */
  private async credential(tenantId: string, scope: CredentialScope): Promise<{ apiKey: string; connectorId: string | null }> {
    try {
      const cred = await getWebToolCredential(tenantId, 'tavily', scope);
      return { apiKey: cred.apiKey, connectorId: cred.connectorId };
    } catch (err) {
      if (!(err instanceof VendorNotConnected)) throw err;
    }
    // A platform key that cannot be read is the vendor being out, not a
    // caller mistake: typed as a 503 so the router parks the rung for the
    // health window instead of spending an attempt on it every call.
    try {
      return { apiKey: await getWebToolSecret('tavily-api-key'), connectorId: null };
    } catch (err) {
      throw new TavilyError(`tavily platform key unavailable: ${(err as Error).message}`, 503);
    }
  }

  classifyVendorError(error: unknown): VendorErrorCode | null {
    if (!(error instanceof TavilyError)) return null;
    const status = error.statusCode;
    if (status === 401 || status === 403) return 'invalid_key';
    if (status === 402) return 'insufficient_funds';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'vendor_down';
    return null;
  }

  async fetch(req: WithTenant<WebFetchAdvancedRequest>): Promise<InternalWebFetchAdvancedResult> {
    // Contract mismatches — surface as 400 (non-transient) so chain
    // escalates without poisoning vendor health.
    if (req.sessionId)        throw new TavilyError('Tavily does not support sessions',  400);
    if (req.vendorProfileId)  throw new TavilyError('Tavily does not support vendor profiles (no session)',  400);
    if (req.vendorIdentityId) throw new TavilyError('Tavily does not support vendor identities (no session)', 400);
    const { data, funding } = await this.call<TavilyExtractResponse>('/extract', {
      urls: [req.url],
      extract_depth: 'basic',
      include_usage: true,
    }, req);
    const hit = data.results[0];
    const content = hit?.raw_content ?? '';
    if (content.length === 0) {
      const failure = data.failed_results[0]?.error;
      throw new TavilyError(
        failure
          ? `Tavily /extract failed: ${failure}`
          : 'Empty content from Tavily /extract (likely antibot block)',
        200,
      );
    }
    return {
      content,
      finalUrl: hit?.url ?? req.url,
      sessionId: undefined,
      vendor: 'tavily',
      costMicros: Math.round(data.usage.credits * USD_PER_CREDIT * 1_000_000),
      jsRendered: false,
      ...(funding ? { funding } : {}),
    };
  }

  async research(req: WithTenant<WebResearchRequest>): Promise<InternalWebResearchResult> {
    const max = Math.min(req.maxSources ?? 10, MAX_RESULTS_CEILING);
    const { data, funding } = await this.call<TavilySearchResponse>('/search', {
      query: req.question,
      search_depth: 'basic',
      max_results: max,
      include_answer: true,
      include_usage: true,
    }, req);
    const sources = data.results.map(r => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: r.content,
    }));
    const answer = data.answer
      ?? data.results.map(h => `${h.title ?? h.url}\n${h.content}`).join('\n\n');
    return {
      answer,
      sources,
      vendor: 'tavily',
      costMicros: Math.round(data.usage.credits * USD_PER_CREDIT * 1_000_000),
      ...(funding ? { funding } : {}),
    };
  }

  protected async call<T>(path: string, body: unknown, req: { tenantId: string; credentialScope: CredentialScope }): Promise<{ data: T; funding?: WebToolFunding }> {
    const { tenantId } = req;
    const cred = await this.credential(tenantId, req.credentialScope);
    let res: Response;
    try {
      res = await fetch(`${TAVILY_BASE_URL}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
      });
    } catch (e) {
      throw new TavilyError(`Network: ${(e as Error).message}`, 0);
    }
    // Read what the vendor said about its limits, on every response —
    // a header saying "3 calls left" is only ever on the success path, and
    // it is worth knowing before the fourth call is the one that fails.
    // A 429 also sets this key aside so the next request takes the tenant's
    // next key rather than the one that just asked us to stop.
    // The pool's bookkeeping is per connector row; the platform key has none.
    if (cred.connectorId !== null) {
      observeVendorResponse({
        tenantId, vendor: 'tavily', connectorId: cred.connectorId,
        status: res.status, headers: res.headers,
      });
    }
    if (!res.ok) {
      let err: { error?: string; detail?: string } | undefined;
      try { err = await res.json() as { error?: string; detail?: string }; } catch { /* response body not JSON */ }
      const tErr = new TavilyError(
        `Tavily ${res.status}: ${err?.error ?? err?.detail ?? res.statusText}`,
        res.status, err,
      );
      const classified = this.classifyVendorError(tErr);
      // On the platform key an exhausted or refused account is our funding
      // matter, not the workspace's: it leaves as the vendor's own error and
      // the chain moves to the next rung.
      if (cred.connectorId !== null && (classified === 'insufficient_funds' || classified === 'invalid_key')) {
        await markConnectorErrored(
          tenantId, 'tavily', cred.connectorId, classified, tErr.message,
        );
        throw new BYOKVendorError(
          classified, 'tavily', tenantId, cred.connectorId,
          buildByokErrorMessage('tavily', classified),
        );
      }
      throw tErr;
    }
    return { data: await res.json() as T, ...(cred.connectorId === null ? { funding: 'platform' as const } : {}) };
  }
}

// Reference logger to keep import non-empty in environments where it's unused.
void logger;
