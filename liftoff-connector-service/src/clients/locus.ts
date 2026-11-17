// Locus native executor — people and company enrichment resold per call on
// one prepaid credit balance the platform funds.
//
// One workspace secret key from the environment, one call shape:
// POST https://api.paywithlocus.com/api/wrapped/credits/{provider}/{endpoint}
// with the provider's own request body and an Idempotency-Key. The body that
// comes back is the provider's raw response; the money rides on the response
// headers (`X-Locus-Cost-Usd`, `X-Locus-Credits-Charged`, 1 credit = $0.001),
// and that charge is this call's costUsd, funded by the platform
// (`platform_key`). A 402 is Locus's own balance, worded as an explicit
// payment-required status so the capability path parks this rung for a
// while instead of retrying it every call. Every function in
// catalog/generated/locus.ts is one catalog slug; the model never sees it.
//
// The key is a trusted-server credential (it carries workspace management
// authority) and lives only here, never in an agent, a browser or an MCP
// client: this executor is the one place the platform speaks to Locus.

import { randomUUID } from 'node:crypto';
import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { LOCUS_DISPATCH } from '../catalog/generated/locus.js';
import { LOCUS_PARSE_DISPATCH } from '../catalog/generated/locus-parse.js';
import { makePublicWebTransport, DEFAULT_PUBLIC_WEB_HEADERS, type ConnectorTransport } from './connector-transport.js';

export const LOCUS_API_BASE = 'https://api.paywithlocus.com/api';
export const LOCUS_API_KEY_ENV = 'LOCUS_API_KEY';
const CREDITS_PER_USD = 1000;

export function isLocusConfigured(): boolean {
  return Boolean(process.env[LOCUS_API_KEY_ENV]?.trim());
}

/** What a metered Locus call answered: the provider's body and what it cost. */
export interface LocusCall {
  status: number;
  body: unknown;
  /** USD, from `X-Locus-Cost-Usd`, else credits / 1000; undefined when Locus
   *  reported neither (a refusal, a replay it did not charge). */
  costUsd?: number;
  balanceCredits?: number;
  apiCallId?: string;
}

export class LocusRefusal extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'LocusRefusal';
  }
}

function numberHeader(resp: Response, name: string): number | undefined {
  const v = resp.headers.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface LocusErrorBody {
  error?: string | { message?: string; code?: string };
  message?: string;
  requiredCredits?: string;
  availableCredits?: string;
}

/** The refusal Locus or the provider gave, worded for the capability path:
 *  an empty balance reads as payment required and parks the rung; anything
 *  else is the vendor's own account of it.
 *
 *  BOTH HALVES OF IT. Locus refuses with `{error, message}` where `error` is
 *  a category and `message` is the reason — `{"error":"Invalid request",
 *  "message":"location must be one of: Austin, TX, Chicago, IL, …"}`. Keeping
 *  only `error` is why every rejected Zillow search reached the logs and the
 *  model as a bare "HTTP 400 Invalid request", with the one sentence that
 *  said what was wrong thrown away. */
function refusalText(status: number, body: LocusErrorBody): string {
  const e = body.error;
  // `error` as a STRING is a category and `message` is the reason, so both go
  // through; `error` as an object carries the reason itself.
  const parts = typeof e === 'string' ? [e, body.message] : [e?.message ?? body.message];
  const text = [...new Set(parts.filter((s): s is string => typeof s === 'string' && s.trim().length > 0))].join(': ');
  if (status === 402) {
    const need = body.requiredCredits ? ` (needs ${body.requiredCredits} credits, has ${body.availableCredits ?? '?'})` : '';
    return `HTTP 402 payment required: insufficient credits${need}`;
  }
  return `HTTP ${status}${text ? ` ${text}` : ''}`;
}

/** One metered call on the platform's Locus key. Throws LocusRefusal on a
 *  non-2xx answer; the caller decides what a refusal means for it. */
export async function locusCall(
  slug: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
  transport: ConnectorTransport = locusTransport(),
): Promise<LocusCall> {
  const resp = await transport({
    method: 'POST',
    url: `${LOCUS_API_BASE}/wrapped/credits/${slug}`,
    headers: { 'Idempotency-Key': idempotencyKey },
    body,
  });
  const parsed = (await resp.json().catch(() => null)) as unknown;
  const costUsd = numberHeader(resp, 'x-locus-cost-usd')
    ?? (numberHeader(resp, 'x-locus-credits-charged') !== undefined ? (numberHeader(resp, 'x-locus-credits-charged') as number) / CREDITS_PER_USD : undefined);
  if (!resp.ok) {
    throw new LocusRefusal(refusalText(resp.status, (parsed ?? {}) as LocusErrorBody), resp.status);
  }
  return {
    status: resp.status,
    body: parsed,
    costUsd,
    balanceCredits: numberHeader(resp, 'x-locus-credits-balance'),
    apiCallId: resp.headers.get('x-locus-api-call-id') ?? undefined,
  };
}

/** The aggregator's free market-data lane answers with the supplier's own
 *  CATALOGUE ENVELOPE wrapped around the data: route templates for the reads it
 *  documents, an `available` flag about those routes, a prose note in the
 *  supplier's voice and a support email address. Neither half of that may be
 *  passed through as it stands.
 *
 *  It NAMES THE SUPPLIER. `contact` is the vendor's own address and the note is
 *  its voice, so a model reading the result learns exactly which supplier
 *  answered — the one thing the capability naming exists to prevent, undone by
 *  the payload. Observed live on `us_stock_symbols`, which has been returning
 *  the vendor's domain and mailbox to every caller since it shipped, and on the
 *  free market-data reads, whose note upsells a paid realtime feed. And
 *  `pricePerCall` is the vendor's price for THAT feed, not what this call
 *  costs, so it has no business in a result either.
 *
 *  And on a read whose whole answer is a FIGURE, `available: false` is the
 *  supplier saying it does not serve that data. Returning it as a success is a
 *  fabricated success: nothing retries, nothing falls through to another rung,
 *  and the answer carries no figure. A DIRECTORY read is the other way around —
 *  its own payload is the symbol list, and the flag describes the price routes
 *  it documents rather than itself, so it stays a success with the envelope
 *  stripped. */
const FREE_MARKET_DATA_LANE = /^x402-blockrun-(fx|commodity|public)-/;

const SUPPLIER_ENVELOPE_KEYS = ['endpoints', 'note', 'contact', 'available', 'pricePerCall', 'free'];

/** The free market-data reads whose whole answer is one figure. */
const FIGURE_READS = new Set(['currency_daily_exchange_rate', 'commodity_daily_price']);

function shapeFreeMarketData(
  slug: string,
  functionName: string,
  body: JsonObject,
): { result: JsonObject } | { failure: string } {
  if (!FREE_MARKET_DATA_LANE.test(slug)) return { result: body };
  if (FIGURE_READS.has(functionName) && body.available === false) {
    return { failure: 'the source does not currently serve this reading' };
  }
  const shaped: JsonObject = {};
  for (const [k, v] of Object.entries(body)) {
    if (!SUPPLIER_ENVELOPE_KEYS.includes(k)) shaped[k] = v;
  }
  return { result: shaped };
}

function locusTransport(): ConnectorTransport {
  const apiKey = process.env[LOCUS_API_KEY_ENV]?.trim() ?? '';
  return makePublicWebTransport('locus', {
    ...DEFAULT_PUBLIC_WEB_HEADERS,
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  });
}

/** The platform's prepaid Locus balance, in USD: what every locus rung has
 *  left to spend. Read by the balance route for platform-backend's
 *  vendor-spend monitor; the dashboard's auto-recharge keeps it funded, and
 *  the monitor is how anyone hears when that stops. */
export async function locusBalanceUsd(): Promise<number> {
  if (!isLocusConfigured()) throw new Error('locus credential is not provisioned (no platform key)');
  const resp = await locusTransport()({ method: 'GET', url: `${LOCUS_API_BASE}/credits/balance` });
  const body = (await resp.json().catch(() => ({}))) as { usd?: string | number };
  if (!resp.ok) throw new Error(`locus balance: HTTP ${resp.status}`);
  const usd = Number(body.usd);
  if (!Number.isFinite(usd)) throw new Error('locus balance: no usd figure in the answer');
  return usd;
}

export async function locusExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const dispatch = LOCUS_DISPATCH[ctx.functionName] ?? LOCUS_PARSE_DISPATCH[ctx.functionName];
  if (!dispatch) {
    return { result: {}, failure: { message: `locus has no tool named ${ctx.functionName}` } };
  }
  if (!isLocusConfigured()) {
    return { result: {}, failure: { message: 'locus credential is not provisioned (no platform key)' } };
  }
  const started = Date.now();
  try {
    // A pass-through entry carries the vendor's own path and method as Locus's
    // control fields, with the function's input as the vendor's query (GET)
    // or body (POST). The model only ever supplies the vendor's parameters.
    const input = ctx.input as Record<string, unknown>;
    const body: Record<string, unknown> = dispatch.mpp
      ? dispatch.mpp.method === 'GET'
        ? { _method: 'GET', _path: dispatch.mpp.path, _query: input }
        : { _method: 'POST', _path: dispatch.mpp.path, ...input }
      : input;
    // Locus refuses a call with no Idempotency-Key (HTTP 400). A caller
    // that sent none gets a key of this call's own: the charge is then
    // replay-safe only for the callers that do send one, which is the
    // contract they already have everywhere else.
    const call = await locusCall(dispatch.slug, body, ctx.idempotencyKey?.trim() || randomUUID());
    const vendorLatencyMs = Date.now() - started;
    const payload = call.body;
    const raw: JsonObject =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as JsonObject)
        : ({ items: payload ?? [] } as unknown as JsonObject);
    // Locus reports the charge on every burn; the listed price stands in only
    // if it ever does not, so a paid call is never recorded as free.
    const costUsd = call.costUsd ?? dispatch.priceUsd;
    const shaped = shapeFreeMarketData(dispatch.slug, ctx.functionName, raw);
    if ('failure' in shaped) {
      // The call itself succeeded and may have been charged, so the cost is
      // reported either way; what the source refused is the reading.
      return {
        result: {},
        vendorLatencyMs,
        costUsd,
        fundingSource: 'platform_key',
        failure: { message: `locus ${ctx.functionName} failed: ${shaped.failure}` },
      };
    }
    return { result: shaped.result, vendorLatencyMs, costUsd, fundingSource: 'platform_key' };
  } catch (err) {
    const message = err instanceof LocusRefusal
      ? `locus ${ctx.functionName} failed: ${err.message}`
      : `locus ${ctx.functionName} failed: ${(err as Error).message}`;
    return { result: {}, vendorLatencyMs: Date.now() - started, failure: { message } };
  }
}

registerConnectorExecutor('locus', locusExecutor);
