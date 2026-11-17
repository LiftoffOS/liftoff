// xAI, as a web-tools vendor. Two tools: web_x_search, and the bridged
// web_search for a Grok run.
//
// X is the capability no other vendor here has, which is the whole reason this
// client exists. It is deliberately NOT limited to agents running Grok: an
// agent's model should not decide whether the platform can reach X, exactly as
// web_people_search is Perplexity-backed without forcing an agent onto
// Perplexity.
//
// Web search is the other way round: it is here FOR Grok. The rule every
// engine follows is the model vendor's own hosted search, and on opencode —
// Grok's engine — xAI's server-side `web_search` cannot be attached to the
// model's own calls, so the platform's bridged `web_search` tool runs it here
// instead, on Liftoff's xAI key, and hands the model the cited answer.
//
// Shaped from the live API rather than the docs. Probed against api.x.ai:
//
//   - x_search is a SERVER-SIDE tool on /v1/responses, declared as
//     `{"type":"x_search"}` in `tools`. Chat Completions refuses it outright,
//     naming `function` and `live_search` as the only tool types it knows.
//   - it fans out internally to `x_keyword_search` and `x_semantic_search`,
//     which surface as `custom_tool_call` output items — NOT as `x_search_call`
//     items the way web_search surfaces as `web_search_call`.
//   - the findings come back as prose in the `message` item, annotated with
//     `url_citation` entries pointing at individual x.com posts. There is no
//     structured record block, which is why this returns answer + sources.
//   - the CALL COUNT is in `usage.server_side_tool_usage_details.x_search_calls`,
//     which is what it is billed on: $5 per 1,000 calls. Counting the
//     `custom_tool_call` items would count the internal fan-out instead, and
//     the two are not the same number.

import { getWebToolSecret } from './web-tool-secrets';
import { logger } from '../../infrastructure/logging';
import type { InternalWebSearchResult, InternalWebXSearchResult, WebSearchRequest, WebXSearchRequest } from './types';

const XAI_RESPONSES_URL = () =>
  `${process.env.XAI_BASE_URL ?? 'https://api.x.ai'}/v1/responses`;

/** $5 per 1,000 x_search calls (docs.x.ai/developers/pricing, read 2026-09-05),
 *  expressed in micros to match every other web-tool cost on this path. The
 *  FLOOR of a call's cost — the tool fee alone — billed only when the response
 *  carries no exact figure (see `exactCostMicros`). */
const X_SEARCH_MICROS_PER_CALL = 5_000;
/** $5 per 1,000 web_search calls (docs.x.ai/developers/pricing, read
 *  2026-09-15: "Web Search | web_search | $5"). The same figure the wire
 *  engine's `xaiWebSearchCostUsd` bills a Grok run's native search at. The
 *  floor, as above. */
const WEB_SEARCH_MICROS_PER_CALL = 5_000;
/** 1 USD = 10^10 ticks (docs.x.ai/developers/cost-tracking, read 2026-09-15),
 *  so a micro is 10^4 ticks. */
const TICKS_PER_MICRO = 10_000;

const XAI_MODEL = process.env.XAI_WEB_TOOL_MODEL ?? 'grok-4.3';

interface XaiResponsesBody {
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string; title?: string }>;
    }>;
  }>;
  usage?: {
    cost_in_usd_ticks?: number;
    server_side_tool_usage_details?: { x_search_calls?: number; web_search_calls?: number };
  };
  error?: unknown;
}

/** The cited pages from a message's annotations, deduped by url: xAI
 *  annotates every span it drew from, so one page cited three times appears
 *  three times, and a source list that repeats is noise rather than three
 *  sources. */
function citedSources(
  part: { annotations?: Array<{ type?: string; url?: string; title?: string }> } | undefined,
): Array<{ url: string; title: string }> {
  const seen = new Set<string>();
  const sources: Array<{ url: string; title: string }> = [];
  for (const a of part?.annotations ?? []) {
    if (a.type !== 'url_citation' || !a.url || seen.has(a.url)) continue;
    seen.add(a.url);
    // The annotation's `title` is the citation's ordinal in the prose ("1",
    // "2"), not the page's title; a bare number names nothing, so the URL
    // stands in for it.
    const title = a.title && !/^\d+$/.test(a.title) ? a.title : a.url;
    sources.push({ url: a.url, title });
  }
  return sources;
}

/**
 * What the request cost, from the vendor's own account of it.
 *
 * `usage.cost_in_usd_ticks` is "the actual amount billed, after all
 * applicable discounts (including prompt caching reductions) have been
 * applied, and inclusive of all token costs and server-side tool invocation
 * costs" (docs.x.ai/developers/cost-tracking). That is the whole cost of a
 * search on this surface — the model's tokens across its tool loop as well as
 * the per-call tool fee — and the tokens are the larger part: a single
 * web_search with five underlying calls billed $0.045 against a $0.025 fee.
 *
 * Where the field is absent the tool fee alone is billed, as the documented
 * floor, and said so: the search already ran and the vendor already charged
 * for it, so refusing the result would cost the same and return nothing.
 */
function exactCostMicros(
  usage: XaiResponsesBody['usage'],
  floorMicros: number,
  context: 'web_x_search' | 'web_search',
): number {
  const ticks = usage?.cost_in_usd_ticks;
  if (typeof ticks === 'number' && ticks >= 0) return Math.round(ticks / TICKS_PER_MICRO);
  logger.warn({ context, floor_micros: floorMicros }, 'xai: response carried no cost_in_usd_ticks; billing the tool fee alone');
  return floorMicros;
}

export class XaiClient {
  /**
   * Search X and return what xAI found, with the posts it cited.
   *
   * The request is a natural-language instruction rather than a filter object,
   * because that is the surface x_search offers: the model decides its own
   * keyword and semantic fan-out. `fromDate` and `handles` are folded into the
   * instruction for the same reason — there is no parameter to put them in.
   */
  async xSearch(req: WebXSearchRequest): Promise<InternalWebXSearchResult> {
    const key = await getWebToolSecret('xai-api-key');
    const max = req.maxSources ?? 10;
    const from = req.fromDate ? ` Only consider posts from ${req.fromDate} onward.` : '';
    const who = req.handles?.length
      ? ` Restrict to posts from these accounts: ${req.handles.map(h => `@${h.replace(/^@/, '')}`).join(', ')}.`
      : '';

    const res = await fetch(XAI_RESPONSES_URL(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: XAI_MODEL,
        input: [{
          role: 'user',
          content:
            `Search X for: ${req.query}.${from}${who}`
            + ` Consult up to ${max} posts. Summarise what was said and by whom,`
            + ` and cite the posts you used.`,
        }],
        tools: [{ type: 'x_search' }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`xai x_search failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const body = (await res.json()) as XaiResponsesBody;

    const message = (body.output ?? []).find(o => o.type === 'message');
    const part = (message?.content ?? []).find(c => c.type === 'output_text');
    const answer = part?.text ?? '';

    // Citations are the only structured handle on WHICH posts were used.
    const sources: InternalWebXSearchResult['sources'] = citedSources(part);

    // The vendor's own count, not ours. The tool fee is per CALL, so an
    // undercount here is money we do not charge — and xAI's internal fan-out
    // means the item count and the call count genuinely differ.
    const calls = body.usage?.server_side_tool_usage_details?.x_search_calls ?? 0;
    if (calls === 0) {
      // Worth saying: it means the model answered without searching, and the
      // answer is then its own recollection rather than anything from X.
      logger.info({ query_length: req.query.length }, 'web_x_search: model answered without searching X');
    }

    return {
      answer,
      sources,
      vendor: 'xai',
      costMicros: exactCostMicros(body.usage, calls * X_SEARCH_MICROS_PER_CALL, 'web_x_search'),
    };
  }

  /**
   * Search the web through xAI's hosted `web_search`, for a Grok run.
   *
   * The same surface as x_search — the Responses API, a natural-language
   * instruction, a server-side tool the model drives — and the same shape
   * back: prose in the `message` item with `url_citation` annotations naming
   * the pages, which become the results. The count is the vendor's own: web
   * search activity surfaces as `web_search_call` output items on this API
   * (docs.x.ai/developers/tools/tool-usage-details, read 2026-09-15), and the
   * usage block carries a per-category count where it reports one; the block
   * is read first and the items counted when it does not, so an internal
   * fan-out is never billed as several searches.
   */
  async webSearch(req: WebSearchRequest): Promise<InternalWebSearchResult> {
    const key = await getWebToolSecret('xai-api-key');
    const max = Math.max(1, Math.min(req.maxResults ?? 10, 20));

    const res = await fetch(XAI_RESPONSES_URL(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: XAI_MODEL,
        input: [{
          role: 'user',
          content:
            `Search the web for: ${req.query}.`
            + ` Consult up to ${max} pages. List the most relevant results, one line each with its title and`
            + ` what it says about the query, and cite every page you used.`,
        }],
        tools: [{ type: 'web_search' }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`xai web_search failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const body = (await res.json()) as XaiResponsesBody;

    const message = (body.output ?? []).find(o => o.type === 'message');
    const part = (message?.content ?? []).find(c => c.type === 'output_text');
    const summary = part?.text ?? '';
    const results = citedSources(part);

    const reported = body.usage?.server_side_tool_usage_details?.web_search_calls;
    const calls = typeof reported === 'number'
      ? reported
      : (body.output ?? []).filter(o => o.type === 'web_search_call').length;
    if (calls === 0) {
      logger.info({ query_length: req.query.length }, 'web_search: xAI answered without searching the web');
    }

    return {
      results,
      summary,
      vendor: 'xai',
      costMicros: exactCostMicros(body.usage, calls * WEB_SEARCH_MICROS_PER_CALL, 'web_search'),
    };
  }
}
