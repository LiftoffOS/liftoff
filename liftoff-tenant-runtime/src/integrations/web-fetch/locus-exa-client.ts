// The platform's overflow for Exa: the same page read and search Exa serves
// on the platform's own key, reached through connector-service on the
// platform's Locus key, which resells Exa's x402 API per call.
//
// The platform's Exa plan is capped at ten queries a second and the next
// tier is bought with a deposit, so this rung stands directly behind the
// platform's Exa in the tier and is taken when that key is rate-limited (a
// 429, or the runtime's own admission cap for it). Nothing here holds a key;
// the charge Locus reports comes back as costUsd and the result carries
// funding 'platform', so the customer's Operating Units are drawn from the
// call's real cost. Errors are LocusWebError, the one classification the
// router has for the Locus key: a 402 is the platform's Locus balance.

import { randomUUID } from 'crypto';
import { getConnectorServiceClient } from '../../connectors/connector-service-client';
import { LocusWebError } from './locus-web-client';
import type {
  InternalWebFetchAdvancedResult,
  InternalWebResearchResult,
  WebFetchAdvancedRequest,
  WebResearchRequest,
} from './types';

const CONNECTOR_ID = 'internal:locus';
const MAX_RESULTS = 10;

interface ExecuteReply {
  success: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  costUsd?: number;
}

const PAYMENT_REFUSED = /\b402\b|payment required|insufficient credits|not provisioned/i;

function statusOf(reply: ExecuteReply): number {
  if (reply.errorCode === 'vendor_unavailable') return 503;
  if (reply.errorCode === 'rate_limited') return 429;
  if (PAYMENT_REFUSED.test(reply.error ?? '')) return 402;
  return 400;
}

type Ctx = { tenantId: string; traceId?: string };

interface ExaResult { url?: string; title?: string; text?: string; highlights?: string[]; summary?: string }

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function results(reply: ExecuteReply): ExaResult[] {
  const raw = asRecord(reply.result).results;
  return Array.isArray(raw) ? (raw as ExaResult[]) : [];
}
function micros(reply: ExecuteReply): number {
  return Math.round((reply.costUsd ?? 0) * 1_000_000);
}

export class LocusExaClient {
  private async execute(functionName: 'web_page_text' | 'web_semantic_search', input: Record<string, unknown>, ctx: Ctx): Promise<ExecuteReply> {
    const client = getConnectorServiceClient();
    let reply: ExecuteReply;
    try {
      reply = (await client.execute({
        tenantContext: { tenantId: ctx.tenantId },
        connectorId: CONNECTOR_ID,
        functionName,
        input: input as never,
        idempotencyKey: randomUUID(),
        traceId: ctx.traceId,
      })) as ExecuteReply;
    } catch (err) {
      throw new LocusWebError(`locus_exa ${functionName}: ${(err as Error).message}`, 0);
    }
    if (!reply.success) {
      throw new LocusWebError(`locus_exa ${functionName}: ${reply.error || 'connector-service returned an unsuccessful response'}`, statusOf(reply));
    }
    return reply;
  }

  async fetch(req: WebFetchAdvancedRequest & { tenantId: string; traceId?: string }): Promise<InternalWebFetchAdvancedResult> {
    const reply = await this.execute('web_page_text', { urls: [req.url], text: true }, req);
    const page = results(reply)[0];
    const content = typeof page?.text === 'string' && page.text.length > 0 ? page.text : undefined;
    if (content === undefined) {
      throw new LocusWebError('locus_exa web_page_text: no page content in the response', 502);
    }
    return {
      content,
      finalUrl: typeof page.url === 'string' && page.url.length > 0 ? page.url : req.url,
      vendor: 'locus_exa',
      costMicros: micros(reply),
      jsRendered: false,
      funding: 'platform',
    };
  }

  /** Exa's x402 API has no /answer: the search is asked for each page's text
   *  and the answer is the joined pages, the way the Tavily client answers
   *  when the vendor sends none. */
  async research(req: WebResearchRequest & { tenantId: string; traceId?: string }): Promise<InternalWebResearchResult> {
    const numResults = Math.min(Math.max(req.maxSources ?? 5, 1), MAX_RESULTS);
    const reply = await this.execute('web_semantic_search', { query: req.question, numResults, type: 'auto', contents: { text: true } }, req);
    const sources = results(reply).flatMap((r) => {
      if (typeof r.url !== 'string' || r.url.length === 0) return [];
      const snippet = typeof r.text === 'string' ? r.text.slice(0, 2000) : undefined;
      return [{ url: r.url, title: typeof r.title === 'string' && r.title.length > 0 ? r.title : r.url, ...(snippet ? { snippet } : {}) }];
    });
    return {
      answer: sources.map((s) => `${s.title}\n${s.snippet ?? ''}`).join('\n\n'),
      sources,
      vendor: 'locus_exa',
      costMicros: micros(reply),
      funding: 'platform',
    };
  }
}

export const locusExaClient = new LocusExaClient();
