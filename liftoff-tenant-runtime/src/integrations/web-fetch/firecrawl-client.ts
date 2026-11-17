import { logger } from '../../infrastructure/logging';
import type { CredentialScope } from './credential-scope';
import { getWebToolCredential, type WebToolCredential } from './web-tool-secrets';
import { BYOKVendorError, type VendorErrorCode } from './types';
import { buildByokErrorMessage, markConnectorErrored } from './byok-error-handler';
import { observeVendorResponse } from './credential-pool';
import type {
  WebFetchAdvancedClient, WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
  WebExtractRequest, InternalWebExtractResult,
  WebResearchRequest, InternalWebResearchResult,
} from './types';

const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev';
const FIRECRAWL_TIMEOUT_MS = 30_000;

// Credit accounting is plan-independent — pages used equals credits charged
// against the Firecrawl team. USD_PER_CREDIT is the only knob that changes on
// plan upgrades.
const CREDITS_PER_SCRAPE          = 1;
const CREDITS_PER_SCRAPE_W_ACTION = 1;  // wait actions counted within base scrape
const CREDITS_PER_SCRAPE_W_PROXY  = 5;  // enhanced proxy (not used in this initial scope)
const CREDITS_PER_EXTRACT_URL     = 5;
const CREDITS_PER_SEARCH_10       = 2;  // plus scrape costs per result if scrapeOptions set

// BYOK — every tenant brings their own Firecrawl account; the
// USD_PER_CREDIT below is informational only (used for tenant-side analytics).
// The vendor bills the tenant directly, so cost_attribution rows for the
// strict vendors bypass `applyOuConsumption` (see platform-backend Phase 6).
const USD_PER_CREDIT = 0.0032;  // Hobby tier reference; tenant's actual plan varies

interface FirecrawlScrapeResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: { title?: string; sourceURL?: string; url?: string };
  };
}

interface FirecrawlJsonExtractResponse {
  success?: boolean;
  data?: {
    json?: unknown;
    metadata?: { sourceURL?: string; url?: string };
  };
}

interface FirecrawlSearchResponse {
  success?: boolean;
  data?: {
    answer?: string;
    web?: Array<{
      url: string;
      title?: string;
      description?: string;
      markdown?: string;
    }>;
  };
}

export class FirecrawlError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly body?: unknown) {
    super(message); this.name = 'FirecrawlError';
  }
}

// Public request shape — the strict clients require tenantId so the
// per-tenant connector can be resolved. The router injects it; handlers
// that call the router never construct these directly.
/** A router-bound request: the tenant, and which of its connectors may serve
 *  (credential-scope.ts). The scope is required so the compiler refuses a call
 *  that has not decided it. */
type WithTenant<T> = T & { tenantId: string; credentialScope: CredentialScope };

export class FirecrawlClient implements WebFetchAdvancedClient {
  readonly vendor = 'firecrawl' as const;

  supportsSessions(): boolean { return false; }

  private async credential(tenantId: string, scope: CredentialScope): Promise<WebToolCredential> {
    return getWebToolCredential(tenantId, 'firecrawl', scope);
  }

  /** Map a FirecrawlError → BYOK classification, or null when the error
   *  is not BYOK-attributable (network, vendor 5xx, transient). */
  classifyVendorError(error: unknown): VendorErrorCode | null {
    if (!(error instanceof FirecrawlError)) return null;
    const status = error.statusCode;
    if (status === 401 || status === 403) return 'invalid_key';
    if (status === 402) return 'insufficient_funds';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'vendor_down';
    return null;
  }

  async fetch(req: WithTenant<WebFetchAdvancedRequest>): Promise<InternalWebFetchAdvancedResult> {
    if (req.sessionId) throw new Error('Firecrawl does not support sessions');
    const body = {
      url: req.url,
      formats: ['markdown'],
      onlyMainContent: true,
      ...(req.waitFor ? { actions: this.mapWaitFor(req.waitFor) } : {}),
    };
    const data = await this.call<FirecrawlScrapeResponse>(
      '/v2/scrape', body, req,
    );
    const markdown = data.data?.markdown ?? '';
    if (markdown.length === 0) {
      throw new FirecrawlError('Empty markdown from Firecrawl (likely antibot block)', 200);
    }
    const finalUrl = data.data?.metadata?.sourceURL ?? data.data?.metadata?.url ?? req.url;
    const credits = req.waitFor ? CREDITS_PER_SCRAPE_W_ACTION : CREDITS_PER_SCRAPE;
    return {
      content: markdown,
      finalUrl,
      sessionId: undefined,
      vendor: 'firecrawl',
      costMicros: Math.round(credits * USD_PER_CREDIT * 1_000_000),
      jsRendered: !!req.waitFor,
    };
  }

  async extract(req: WithTenant<WebExtractRequest>): Promise<InternalWebExtractResult> {
    // Firecrawl's dedicated /v2/extract endpoint is asynchronous (POST returns
    // a jobId; you must poll GET /v2/extract/<id> until status='completed').
    // The WebFetchAdvancedClient contract is synchronous, so we use
    // /v2/scrape with the structured-output `json` format instead — same
    // schema-guided extraction, single round-trip, returns data.json directly.
    const body = {
      url: req.url,
      formats: [
        {
          type: 'json',
          schema: req.schema,
          ...(req.prompt ? { prompt: req.prompt } : {}),
        },
      ],
      onlyMainContent: true,
    };
    const data = await this.call<FirecrawlJsonExtractResponse>(
      '/v2/scrape', body, req,
    );
    const finalUrl = data.data?.metadata?.sourceURL ?? data.data?.metadata?.url ?? req.url;
    return {
      data: data.data?.json,
      finalUrl,
      vendor: 'firecrawl',
      costMicros: Math.round(CREDITS_PER_EXTRACT_URL * USD_PER_CREDIT * 1_000_000),
      jsRendered: false,
    };
  }

  async research(req: WithTenant<WebResearchRequest>): Promise<InternalWebResearchResult> {
    const limit = req.maxSources ?? 10;
    const body = {
      query: req.question,
      limit,
      scrapeOptions: {
        formats: ['markdown'],
        answer: req.question,
        onlyMainContent: true,
      },
    };
    const data = await this.call<FirecrawlSearchResponse>(
      '/v2/search', body, req,
    );
    const hits = data.data?.web ?? [];
    const answer = data.data?.answer
      ?? hits.map(h => `${h.title ?? h.url}\n${h.description ?? ''}`).join('\n\n');
    const sources = hits.map(h => ({ url: h.url, title: h.title ?? h.url }));
    // 2 credits per 10 results for /search + scrape cost per result.
    const credits = CREDITS_PER_SEARCH_10 + (limit * CREDITS_PER_SCRAPE);
    return {
      answer,
      sources,
      vendor: 'firecrawl',
      costMicros: Math.round(credits * USD_PER_CREDIT * 1_000_000),
    };
  }

  protected async call<T>(path: string, body: unknown, req: { tenantId: string; credentialScope: CredentialScope }): Promise<T> {
    const { tenantId } = req;
    const cred = await this.credential(tenantId, req.credentialScope);
    let res: Response;
    try {
      res = await fetch(`${FIRECRAWL_BASE_URL}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
      });
    } catch (e) {
      throw new FirecrawlError(`Network: ${(e as Error).message}`, 0);
    }
    // Read what the vendor said about its limits, on every response —
    // a header saying "3 calls left" is only ever on the success path, and
    // it is worth knowing before the fourth call is the one that fails.
    // A 429 also sets this key aside so the next request takes the tenant's
    // next key rather than the one that just asked us to stop.
    observeVendorResponse({
      tenantId, vendor: 'firecrawl', connectorId: cred.connectorId,
      status: res.status, headers: res.headers,
    });
    if (!res.ok) {
      let err: { error?: string } | undefined;
      try { err = await res.json() as { error?: string }; } catch { /* response body not JSON */ }
      const fcErr = new FirecrawlError(
        `Firecrawl ${res.status}: ${err?.error ?? res.statusText}`,
        res.status, err,
      );
      // BYOK classification: on insufficient_funds / invalid_key, flip the
      // connector and surface the labeled-block envelope the LLM relays.
      const classified = this.classifyVendorError(fcErr);
      if (classified === 'insufficient_funds' || classified === 'invalid_key') {
        await markConnectorErrored(
          tenantId, 'firecrawl', cred.connectorId, classified, fcErr.message,
        );
        throw new BYOKVendorError(
          classified, 'firecrawl', tenantId, cred.connectorId,
          buildByokErrorMessage('firecrawl', classified),
        );
      }
      throw fcErr;
    }
    return await res.json() as T;
  }

  private mapWaitFor(w: NonNullable<WebFetchAdvancedRequest['waitFor']>) {
    switch (w.type) {
      case 'selector':    return [{ type: 'wait', selector: w.value }];
      case 'time':        return [{ type: 'wait', milliseconds: w.ms }];
      case 'networkidle': return [{ type: 'wait', milliseconds: 2000 }];
    }
  }
}

// Reference logger to keep import non-empty in environments where it's unused.
void logger;
// Reference unused proxy-credit constant so plan-upgrade code keeps the
// structural reminder until enhanced proxy is wired in.
void CREDITS_PER_SCRAPE_W_PROXY;
