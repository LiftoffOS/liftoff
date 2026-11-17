// Y Combinator directory native executor — YC's own public companies API.
//
// api.ycombinator.com/v0.1/companies is keyless and free: a paged listing
// (20 a page) with `q`, `batch`, `industry` and `status` filters, each row a
// company profile (slug, one-liner, description, batch, team size, status,
// industries, tags, regions, locations, badges, website). There is no
// per-company route, so a profile by slug is a search on the slug with the
// exact match picked out of the first pages; the search is fuzzy, which is
// why the match is on the slug and not the first row. Free at the source:
// costUsd 0, nothing booked. Browser-shaped headers on the public-web
// transport, no credential of any kind.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { makePublicWebTransport, DEFAULT_PUBLIC_WEB_HEADERS } from './connector-transport.js';

const API_URL = 'https://api.ycombinator.com/v0.1/companies';
/** How many search pages a profile lookup reads before giving up: the slug
 *  search is fuzzy but the exact slug is on the first page in practice. */
const PROFILE_PAGES = 3;

type YcCompany = JsonObject;
interface YcPage { companies?: YcCompany[]; page?: number; totalPages?: number; nextPage?: string | null }

function str(input: JsonObject, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function pageNumber(input: JsonObject): number {
  const v = input.page;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
/** A slug goes into a query, never a path, but only the directory's own
 *  alphabet is accepted so a crafted value cannot become anything else. */
function safeSlug(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  const s = slug.trim().toLowerCase();
  return /^[a-z0-9-]{1,80}$/.test(s) ? s : undefined;
}

async function readPage(transport: ReturnType<typeof makePublicWebTransport>, query: URLSearchParams): Promise<YcPage> {
  const resp = await transport({ method: 'GET', url: `${API_URL}?${query.toString()}` });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as YcPage;
}

export async function ycombinatorExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const input = (ctx.input ?? {}) as JsonObject;
  const transport = makePublicWebTransport('ycombinator', DEFAULT_PUBLIC_WEB_HEADERS);
  const started = Date.now();
  try {
    if (ctx.functionName === 'yc_companies_search') {
      const query = new URLSearchParams();
      for (const key of ['q', 'batch', 'industry', 'status'] as const) {
        const v = str(input, key === 'q' ? 'query' : key);
        if (v) query.set(key, v);
      }
      query.set('page', String(pageNumber(input)));
      const page = await readPage(transport, query);
      return {
        result: { companies: page.companies ?? [], page: page.page ?? pageNumber(input), totalPages: page.totalPages ?? null } as JsonObject,
        vendorLatencyMs: Date.now() - started,
        costUsd: 0,
        fundingSource: 'platform_key',
      };
    }
    if (ctx.functionName === 'yc_company_profile') {
      const slug = safeSlug(str(input, 'slug'));
      if (!slug) return { result: {}, failure: { message: 'yc_company_profile needs a company slug (letters, digits and dashes)' } };
      for (let p = 1; p <= PROFILE_PAGES; p++) {
        const page = await readPage(transport, new URLSearchParams({ q: slug, page: String(p) }));
        const hit = (page.companies ?? []).find((c) => typeof c.slug === 'string' && c.slug.toLowerCase() === slug);
        if (hit) return { result: { company: hit } as JsonObject, vendorLatencyMs: Date.now() - started, costUsd: 0, fundingSource: 'platform_key' };
        if (!page.totalPages || p >= page.totalPages) break;
      }
      return { result: {}, vendorLatencyMs: Date.now() - started, failure: { message: `no company in the directory has the slug '${slug}'` } };
    }
    return { result: {}, failure: { message: `ycombinator has no tool named ${ctx.functionName}` } };
  } catch (err) {
    return {
      result: {},
      vendorLatencyMs: Date.now() - started,
      failure: { message: `ycombinator ${ctx.functionName} failed: ${(err as Error).message}` },
    };
  }
}

registerConnectorExecutor('ycombinator', ycombinatorExecutor);
