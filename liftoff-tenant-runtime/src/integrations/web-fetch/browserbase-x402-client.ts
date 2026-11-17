// The Browserbase pay-per-use gateway, reached through connector-service.
//
// Not the BYOK 'browserbase' vendor (a workspace's own key, driven from this
// process). This is browserbase's per-call surface: each call answers a 402
// that connector-service pays from the platform x402 wallet, and the settled
// amount comes back as the call's costUsd with funding_source 'x402_wallet'.
// Nothing here holds a key or a secret, which is why the vendor is
// platform-managed in the router (available whenever its flag is on).
//
// It is the LAST rung of the fetch and search chains. The platform browser
// (Steel, then Browser Use) serves a page first; this vendor runs only when
// every vendor ahead of it is unavailable or marked unhealthy, which is what
// makes it a fallback rather than a competitor. Two tools exist on the
// gateway — a search and a page fetch — and only those two; sessions are a
// resource the browser stack owns end to end and are not served here.
//
// The result carries funding 'x402_wallet' so billing books it under the
// wallet-funded bucket that the on-chain reconciliation sums.

import { getConnectorServiceClient } from '../../connectors/connector-service-client';
import { htmlToMarkdown } from './markdown';
import type {
  InternalWebFetchAdvancedResult,
  InternalWebSearchResult,
  WebFetchAdvancedRequest,
  WebSearchRequest,
} from './types';

const CONNECTOR_ID = 'internal:browserbase_x402';

/** The gateway's own ceiling on search results. */
const MAX_SEARCH_RESULTS = 25;

/** The runtime's per-call answer from connector-service, narrowed to what
 *  this client reads. */
interface ExecuteReply {
  success: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  costUsd?: number;
  fundingSource?: string;
}

export class BrowserbaseX402Error extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'BrowserbaseX402Error';
  }
}

/** A refusal to pay reads as a 402 whatever produced it: the wallet is
 *  unfunded, the spend guard's per-call cap, or the daily ceiling. The router
 *  treats 402 from this vendor as transient, so the rung stands down for the
 *  health window instead of retrying an unpayable call on every request. */
const PAYMENT_REFUSED = /\b402\b|payment (?:required|refused)|insufficient|x402 payment refused|wallet_not_configured|not configured/i;

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

export class BrowserbaseX402Client {
  private async execute(
    functionName: 'fetch_page_content' | 'search_the_web',
    input: Record<string, unknown>,
    ctx: Ctx,
  ): Promise<ExecuteReply> {
    const client = getConnectorServiceClient();
    let reply: ExecuteReply;
    try {
      reply = (await client.execute({
        tenantContext: { tenantId: ctx.tenantId },
        connectorId: CONNECTOR_ID,
        functionName,
        input: input as never,
        traceId: ctx.traceId,
      })) as ExecuteReply;
    } catch (err) {
      // A thrown ConnectError is the wire, not the vendor: no status to read.
      throw new BrowserbaseX402Error(`browserbase_x402 ${functionName}: ${(err as Error).message}`, 0);
    }
    if (!reply.success) {
      throw new BrowserbaseX402Error(
        `browserbase_x402 ${functionName}: ${reply.error || 'connector-service returned an unsuccessful response'}`,
        statusOf(reply),
      );
    }
    return reply;
  }

  async fetch(req: WebFetchAdvancedRequest & { tenantId: string; traceId?: string }): Promise<InternalWebFetchAdvancedResult> {
    const reply = await this.execute('fetch_page_content', { url: req.url, allowRedirects: true }, req);
    // The executor returns the gateway's JSON as it came: `{ id, statusCode,
    // headers, contentType, encoding, content }` (confirmed on a paid call),
    // the body raw under `content` and no final URL. HTML goes
    // through the same converter every browser client uses, so the agent
    // reads the page the way it reads one Steel or Browser Use fetched.
    const outer = asRecord(reply.result);
    const body = { ...asRecord(outer.data), ...outer };
    const raw = str(body.content) ?? str(body.markdown) ?? str(body.text) ?? str(body.html);
    if (raw === undefined) {
      throw new BrowserbaseX402Error('browserbase_x402 fetch_page_content: no page content in the response', 502);
    }
    const isHtml = /html/i.test(str(body.contentType) ?? '') || /^\s*<(?:!doctype|html)/i.test(raw);
    return {
      content: isHtml ? htmlToMarkdown(raw) : raw,
      finalUrl: str(body.finalUrl) ?? str(body.url) ?? req.url,
      vendor: 'browserbase_x402',
      costMicros: Math.round((reply.costUsd ?? 0) * 1_000_000),
      jsRendered: false,
      funding: 'x402_wallet',
    };
  }

  async search(req: WebSearchRequest, ctx: Ctx): Promise<InternalWebSearchResult> {
    const numResults = Math.min(Math.max(req.maxResults ?? 10, 1), MAX_SEARCH_RESULTS);
    const reply = await this.execute('search_the_web', { query: req.query, numResults }, ctx);
    // `{ requestId, query, results: [{ id, url, title, image, favicon }] }`
    // on a paid call: url and title, no snippet.
    const outer = asRecord(reply.result);
    const inner = asRecord(outer.data);
    const raw = [outer.results, inner.results, outer.data].find(Array.isArray) as unknown[] | undefined;
    const results = (raw ?? []).flatMap((item) => {
      const r = asRecord(item);
      const url = str(r.url) ?? str(r.link);
      if (!url) return [];
      return [{
        url,
        title: str(r.title) ?? url,
        ...(str(r.snippet) ?? str(r.description) ? { snippet: str(r.snippet) ?? str(r.description) } : {}),
      }];
    });
    return {
      results,
      vendor: 'browserbase_x402',
      costMicros: Math.round((reply.costUsd ?? 0) * 1_000_000),
      funding: 'x402_wallet',
    };
  }
}

export const browserbaseX402Client = new BrowserbaseX402Client();
