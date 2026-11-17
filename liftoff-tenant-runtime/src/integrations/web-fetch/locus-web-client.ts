// The platform's pay-per-use page scrape, search and extract, reached through
// connector-service on the platform's Locus key.
//
// Not the BYOK 'firecrawl' vendor (a workspace's own key, driven from this
// process): the platform's own Firecrawl key is a free plan with no
// pay-as-you-go, so it is a quota, not a rung. Locus resells Firecrawl per
// call at its listed prices (a scrape $0.003, a search under a cent, an
// extract a cent or two), and connector-service's `internal:locus` executor
// reports each call's charge as costUsd with funding_source 'platform_key'.
// Nothing here holds a key or a secret, which is why the vendor is
// platform-managed in the router (available whenever its flag is on).
//
// A platform-tier rung: behind a team's own bound accounts, ahead of the
// browsers for a page read, the only platform extract backend, and behind
// Perplexity for a basic search. The result carries funding 'platform', the
// ordinary platform-funded bucket the customer's Operating Units are drawn
// from at the call's real cost.

import { randomUUID } from 'crypto';
import { getConnectorServiceClient } from '../../connectors/connector-service-client';
import type {
  InternalWebExtractResult,
  InternalWebFetchAdvancedResult,
  InternalWebSearchResult,
  WebExtractRequest,
  WebFetchAdvancedRequest,
  WebSearchRequest,
} from './types';

const CONNECTOR_ID = 'internal:locus';
const MAX_SEARCH_RESULTS = 20;

interface ExecuteReply {
  success: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  costUsd?: number;
  fundingSource?: string;
}

export class LocusWebError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'LocusWebError';
  }
}

/** An empty Locus balance reads as a 402 whatever produced it, and the router
 *  treats a 402 from this vendor as transient, so the rung stands down for the
 *  health window instead of retrying an unpayable call on every request. */
const PAYMENT_REFUSED = /\b402\b|payment required|insufficient credits|not provisioned/i;

function statusOf(reply: ExecuteReply): number {
  if (reply.errorCode === 'vendor_unavailable') return 503;
  if (reply.errorCode === 'rate_limited') return 429;
  if (PAYMENT_REFUSED.test(reply.error ?? '')) return 402;
  return 400;
}

type Ctx = { tenantId: string; traceId?: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function micros(reply: ExecuteReply): number {
  return Math.round((reply.costUsd ?? 0) * 1_000_000);
}

export class LocusWebClient {
  private async execute(functionName: 'web_page_scrape' | 'web_search_results', input: Record<string, unknown>, ctx: Ctx): Promise<ExecuteReply> {
    const client = getConnectorServiceClient();
    let reply: ExecuteReply;
    try {
      reply = (await client.execute({
        tenantContext: { tenantId: ctx.tenantId },
        connectorId: CONNECTOR_ID,
        functionName,
        input: input as never,
        // Locus requires an Idempotency-Key on every call; the chain never
        // retries a vendor within one call, so each call is its own key.
        idempotencyKey: randomUUID(),
        traceId: ctx.traceId,
      })) as ExecuteReply;
    } catch (err) {
      throw new LocusWebError(`locus_web ${functionName}: ${(err as Error).message}`, 0);
    }
    if (!reply.success) {
      throw new LocusWebError(`locus_web ${functionName}: ${reply.error || 'connector-service returned an unsuccessful response'}`, statusOf(reply));
    }
    return reply;
  }

  async fetch(req: WebFetchAdvancedRequest & { tenantId: string; traceId?: string }): Promise<InternalWebFetchAdvancedResult> {
    const reply = await this.execute('web_page_scrape', {
      url: req.url,
      formats: ['markdown'],
      onlyMainContent: true,
      ...(req.waitFor ? { waitFor: typeof req.waitFor === 'number' ? req.waitFor : 3000 } : {}),
    }, req);
    // Firecrawl's `{ success, data: { markdown, html, metadata: { title,
    // sourceURL, statusCode } } }`, as Locus hands it back raw.
    const outer = asRecord(reply.result);
    const data = { ...asRecord(outer.data), ...(outer.markdown !== undefined ? outer : {}) };
    const content = str(data.markdown) ?? str(data.content) ?? str(data.html);
    if (content === undefined) {
      throw new LocusWebError('locus_web web_page_scrape: no page content in the response', 502);
    }
    const meta = asRecord(data.metadata);
    return {
      content,
      finalUrl: str(meta.sourceURL) ?? str(meta.url) ?? req.url,
      vendor: 'locus_web',
      costMicros: micros(reply),
      jsRendered: true,
      funding: 'platform',
    };
  }

  async search(req: WebSearchRequest, ctx: Ctx): Promise<InternalWebSearchResult> {
    const limit = Math.min(Math.max(req.maxResults ?? 10, 1), MAX_SEARCH_RESULTS);
    const reply = await this.execute('web_search_results', { query: req.query, limit }, ctx);
    // `{ success, data: [{ url, title, description }] }` (v1) or
    // `{ data: { web: [...] } }` (v2).
    const outer = asRecord(reply.result);
    const inner = asRecord(outer.data);
    const raw = [outer.data, inner.web, outer.results, inner.results].find(Array.isArray) as unknown[] | undefined;
    const results = (raw ?? []).flatMap((item) => {
      const r = asRecord(item);
      const url = str(r.url) ?? str(r.link);
      if (!url) return [];
      const snippet = str(r.description) ?? str(r.snippet) ?? str(r.markdown)?.slice(0, 500);
      return [{ url, title: str(r.title) ?? url, ...(snippet ? { snippet } : {}) }];
    });
    return { results, vendor: 'locus_web', costMicros: micros(reply), funding: 'platform' };
  }

  /** Firecrawl's own /extract is asynchronous (a job id to poll), so the
   *  extraction is a scrape in the `json` format: the same schema-guided
   *  read in one round trip, the object under data.json, as the BYOK
   *  Firecrawl client does it. */
  async extract(req: WebExtractRequest & { tenantId: string; traceId?: string }): Promise<InternalWebExtractResult> {
    const reply = await this.execute('web_page_scrape', {
      url: req.url,
      formats: ['json'],
      onlyMainContent: true,
      jsonOptions: { schema: req.schema, ...(req.prompt ? { prompt: req.prompt } : {}) },
    }, req);
    const data = asRecord(asRecord(reply.result).data).json;
    return {
      data,
      finalUrl: req.url,
      vendor: 'locus_web',
      costMicros: micros(reply),
      jsRendered: true,
      funding: 'platform',
    };
  }
}

export const locusWebClient = new LocusWebClient();
