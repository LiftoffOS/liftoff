// DeFi and on-chain market data — the public DefiLlama API, keyless.
//
// Four hosts, one vendor: api.llama.fi (protocol and chain TVL, DEX volume,
// protocol fees and revenue), coins.llama.fi (token prices), yields.llama.fi
// (pool APYs) and stablecoins.llama.fi (stablecoin supply). Every route here
// is the free, open tier: no key, no account, no per-call charge. The vendor's
// paid tier is a different host and is not used.
//
// THE RESPONSES ARE ENORMOUS AND MUST BE SHAPED HERE. Measured:
// the protocol list is 8.9 MB, one protocol's document 10.5 MB (it carries its
// whole daily history and every chain's), the pool list 11.9 MB, the DEX
// overview 19.7 MB and the fee overview 27.5 MB — because each embeds a chart
// of every day since inception. A capability that handed that on would blow
// any budget downstream and answer a question nobody asked, so each function
// projects the fields its capability is about and bounds every list and series
// it returns. The vendor's own filters are used where it has them; the rest is
// filtered and sorted here.
//
// All read-only, all free: `costUsd: 0`, like the other keyless public sources.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { makePublicWebTransport, DEFAULT_PUBLIC_WEB_HEADERS } from './connector-transport.js';

const TVL_BASE = 'https://api.llama.fi';
const COINS_BASE = 'https://coins.llama.fi';
const YIELDS_BASE = 'https://yields.llama.fi';
const STABLECOINS_BASE = 'https://stablecoins.llama.fi';

/** Rows a list function returns unless the caller asks for fewer. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
/** Points a history function returns: a year of daily points, newest last. */
const DEFAULT_HISTORY_POINTS = 90;
const MAX_HISTORY_POINTS = 365;
/** Characters of a vendor description kept. */
const DESCRIPTION_CHARS = 400;

function str(input: JsonObject, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(input: JsonObject, key: string, fallback: number, max: number): number {
  const v = input[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** A protocol or chain name as the vendor's path takes it: its slug. */
function slug(s: string): string {
  return encodeURIComponent(s.trim().toLowerCase().replace(/\s+/g, '-'));
}

function text(v: unknown, chars = DESCRIPTION_CHARS): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return v.length > chars ? `${v.slice(0, chars)}…` : v;
}

function nOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Keep the fields that carry a value, so a projected record has no empty
 *  keys for a reader to wade through. */
function compact(o: Record<string, unknown>): JsonObject {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out as JsonObject;
}

/** The newest `points` of a `{ date, … }` series, oldest first. */
function tail<T>(series: T[] | undefined, points: number): T[] {
  if (!Array.isArray(series)) return [];
  return series.slice(Math.max(0, series.length - points));
}

interface Protocol {
  name?: string; symbol?: string; chain?: string; chains?: string[]; category?: string;
  tvl?: number; change_1d?: number; change_7d?: number; mcap?: number; url?: string;
  description?: string; slug?: string; twitter?: string; audits?: string; listedAt?: number;
}

function projectProtocol(p: Protocol): JsonObject {
  return compact({
    name: p.name,
    symbol: p.symbol && p.symbol !== '-' ? p.symbol : undefined,
    category: p.category,
    chains: Array.isArray(p.chains) ? p.chains.slice(0, 12) : p.chain ? [p.chain] : undefined,
    tvl_usd: nOf(p.tvl),
    change_1d_pct: nOf(p.change_1d),
    change_7d_pct: nOf(p.change_7d),
    market_cap_usd: nOf(p.mcap),
    url: p.url,
    slug: p.slug,
  });
}

type Route = { url: string; shape: (body: unknown, input: JsonObject) => JsonObject };

function routeFor(fn: string, input: JsonObject): Route | { error: string } {
  switch (fn) {
    // ── Protocol and chain TVL ──────────────────────────────────────────
    case 'defi_protocols_search': {
      const q = str(input, 'query')?.toLowerCase();
      const chain = str(input, 'chain')?.toLowerCase();
      const category = str(input, 'category')?.toLowerCase();
      const limit = num(input, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
      return {
        url: `${TVL_BASE}/protocols`,
        shape: (body) => {
          const all = Array.isArray(body) ? (body as Protocol[]) : [];
          const matched = all.filter((p) => {
            if (q && !(p.name ?? '').toLowerCase().includes(q) && !(p.symbol ?? '').toLowerCase().includes(q)) return false;
            if (category && (p.category ?? '').toLowerCase() !== category) return false;
            if (chain) {
              const chains = (p.chains ?? [p.chain ?? '']).map((c) => (c ?? '').toLowerCase());
              if (!chains.includes(chain)) return false;
            }
            return true;
          });
          matched.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
          return {
            protocols: matched.slice(0, limit).map(projectProtocol),
            matched: matched.length,
            total_protocols: all.length,
          } as unknown as JsonObject;
        },
      };
    }
    case 'defi_protocol_tvl': {
      const protocol = str(input, 'protocol');
      if (!protocol) return { error: 'protocol is required (the protocol name or slug, e.g. "aave")' };
      return {
        url: `${TVL_BASE}/tvl/${slug(protocol)}`,
        shape: (body) => ({ protocol, tvl_usd: typeof body === 'number' ? body : Number(body) } as unknown as JsonObject),
      };
    }
    case 'defi_protocol_profile': {
      const protocol = str(input, 'protocol');
      if (!protocol) return { error: 'protocol is required (the protocol name or slug, e.g. "aave")' };
      return {
        url: `${TVL_BASE}/protocol/${slug(protocol)}`,
        shape: (body) => {
          const p = (body ?? {}) as Protocol & { currentChainTvls?: Record<string, number>; tvl?: unknown };
          const chainTvls = p.currentChainTvls ?? {};
          const byChain = Object.entries(chainTvls)
            .filter(([, v]) => typeof v === 'number' && v > 0)
            .sort((a, b) => (b[1] as number) - (a[1] as number))
            .slice(0, 15)
            .map(([chain, tvl]) => ({ chain, tvl_usd: tvl }));
          const series = Array.isArray(p.tvl) ? (p.tvl as Array<{ date?: number; totalLiquidityUSD?: number }>) : [];
          const latest = series.length ? series[series.length - 1] : undefined;
          return compact({
            name: p.name,
            symbol: p.symbol && p.symbol !== '-' ? p.symbol : undefined,
            category: p.category,
            description: text(p.description),
            url: p.url,
            twitter: p.twitter,
            audits: p.audits,
            chains: Array.isArray(p.chains) ? p.chains.slice(0, 15) : undefined,
            tvl_usd: nOf(latest?.totalLiquidityUSD),
            tvl_by_chain: byChain.length ? byChain : undefined,
            market_cap_usd: nOf(p.mcap),
            history_points_available: series.length,
          });
        },
      };
    }
    case 'defi_protocol_tvl_history': {
      const protocol = str(input, 'protocol');
      if (!protocol) return { error: 'protocol is required (the protocol name or slug, e.g. "aave")' };
      const points = num(input, 'points', DEFAULT_HISTORY_POINTS, MAX_HISTORY_POINTS);
      return {
        url: `${TVL_BASE}/protocol/${slug(protocol)}`,
        shape: (body) => {
          const p = (body ?? {}) as { name?: string; tvl?: unknown };
          const series = Array.isArray(p.tvl) ? (p.tvl as Array<{ date?: number; totalLiquidityUSD?: number }>) : [];
          return {
            protocol: p.name ?? protocol,
            points: tail(series, points).map((d) => ({ date: d.date, tvl_usd: d.totalLiquidityUSD })),
            points_available: series.length,
          } as unknown as JsonObject;
        },
      };
    }
    case 'defi_chains_tvl': {
      const limit = num(input, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
      return {
        url: `${TVL_BASE}/v2/chains`,
        shape: (body) => {
          const all = (Array.isArray(body) ? body : []) as Array<{ name?: string; tvl?: number; tokenSymbol?: string }>;
          const sorted = [...all].sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
          return {
            chains: sorted.slice(0, limit).map((c) => compact({ chain: c.name, tvl_usd: nOf(c.tvl), token: c.tokenSymbol })),
            total_chains: all.length,
          } as unknown as JsonObject;
        },
      };
    }
    case 'defi_chain_tvl_history': {
      const chain = str(input, 'chain');
      if (!chain) return { error: 'chain is required (e.g. "Ethereum", "Arbitrum")' };
      const points = num(input, 'points', DEFAULT_HISTORY_POINTS, MAX_HISTORY_POINTS);
      return {
        url: `${TVL_BASE}/v2/historicalChainTvl/${encodeURIComponent(chain.trim())}`,
        shape: (body) => {
          const series = (Array.isArray(body) ? body : []) as Array<{ date?: number; tvl?: number }>;
          return {
            chain,
            points: tail(series, points).map((d) => ({ date: d.date, tvl_usd: d.tvl })),
            points_available: series.length,
          } as unknown as JsonObject;
        },
      };
    }
    // ── Token prices ────────────────────────────────────────────────────
    case 'token_prices_current':
    case 'token_price_change': {
      const coins = input.coins;
      const list = Array.isArray(coins)
        ? coins.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
        : typeof coins === 'string' && coins.trim() ? coins.split(',').map((c) => c.trim()).filter(Boolean) : [];
      if (list.length === 0) {
        return { error: 'coins is required: one or more ids like "coingecko:ethereum" or "ethereum:0x…" (a chain and a token address)' };
      }
      const path = list.slice(0, 50).map((c) => encodeURIComponent(c)).join(',');
      const base = fn === 'token_prices_current' ? `${COINS_BASE}/prices/current/${path}` : `${COINS_BASE}/percentage/${path}`;
      return {
        url: base,
        shape: (body) => {
          const b = (body ?? {}) as { coins?: Record<string, unknown> };
          if (fn === 'token_price_change') {
            return { changes_pct: b.coins ?? {} } as unknown as JsonObject;
          }
          const out: Record<string, unknown> = {};
          for (const [id, v] of Object.entries(b.coins ?? {})) {
            const c = (v ?? {}) as { price?: number; symbol?: string; timestamp?: number; confidence?: number; decimals?: number };
            out[id] = compact({ price_usd: nOf(c.price), symbol: c.symbol, at: c.timestamp, confidence: nOf(c.confidence) });
          }
          return { prices: out } as unknown as JsonObject;
        },
      };
    }
    // ── Stablecoins ─────────────────────────────────────────────────────
    case 'stablecoins_list': {
      const limit = num(input, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
      return {
        url: `${STABLECOINS_BASE}/stablecoins?includePrices=true`,
        shape: (body) => {
          const b = (body ?? {}) as { peggedAssets?: Array<Record<string, unknown>> };
          const assets = b.peggedAssets ?? [];
          const projected = assets.map((a) => {
            const circulating = (a.circulating ?? {}) as Record<string, number>;
            const supply = Object.values(circulating).find((v) => typeof v === 'number');
            return compact({
              name: a.name,
              symbol: a.symbol,
              peg: a.pegType,
              mechanism: a.pegMechanism,
              circulating_usd: nOf(supply),
              price: nOf(a.price as number),
            });
          });
          projected.sort((a, b2) => ((b2 as { circulating_usd?: number }).circulating_usd ?? 0) - ((a as { circulating_usd?: number }).circulating_usd ?? 0));
          return { stablecoins: projected.slice(0, limit), total: assets.length } as unknown as JsonObject;
        },
      };
    }
    case 'stablecoin_supply_by_chain': {
      const limit = num(input, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
      return {
        url: `${STABLECOINS_BASE}/stablecoinchains`,
        shape: (body) => {
          const all = (Array.isArray(body) ? body : []) as Array<{ name?: string; totalCirculatingUSD?: Record<string, number> }>;
          const rows = all.map((c) => {
            const total = Object.values(c.totalCirculatingUSD ?? {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
            return compact({ chain: c.name, circulating_usd: total });
          });
          rows.sort((a, b2) => ((b2 as { circulating_usd?: number }).circulating_usd ?? 0) - ((a as { circulating_usd?: number }).circulating_usd ?? 0));
          return { chains: rows.slice(0, limit), total_chains: all.length } as unknown as JsonObject;
        },
      };
    }
    // ── Yields ──────────────────────────────────────────────────────────
    case 'yield_pools_search': {
      const chain = str(input, 'chain')?.toLowerCase();
      const project = str(input, 'project')?.toLowerCase();
      const symbol = str(input, 'symbol')?.toLowerCase();
      const minTvl = num(input, 'min_tvl_usd', 0, Number.MAX_SAFE_INTEGER);
      const limit = num(input, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
      return {
        url: `${YIELDS_BASE}/pools`,
        shape: (body) => {
          const b = (body ?? {}) as { data?: Array<Record<string, unknown>> };
          const all = b.data ?? [];
          const matched = all.filter((p) => {
            if (chain && String(p.chain ?? '').toLowerCase() !== chain) return false;
            if (project && String(p.project ?? '').toLowerCase() !== project) return false;
            if (symbol && !String(p.symbol ?? '').toLowerCase().includes(symbol)) return false;
            if (minTvl && (nOf(p.tvlUsd) ?? 0) < minTvl) return false;
            return true;
          });
          matched.sort((a, b2) => (nOf(b2.apy) ?? 0) - (nOf(a.apy) ?? 0));
          return {
            pools: matched.slice(0, limit).map((p) => compact({
              chain: p.chain,
              project: p.project,
              symbol: p.symbol,
              tvl_usd: nOf(p.tvlUsd),
              apy_pct: nOf(p.apy),
              apy_base_pct: nOf(p.apyBase),
              apy_reward_pct: nOf(p.apyReward),
              stablecoin: p.stablecoin === true ? true : undefined,
              risk_impermanent_loss: p.ilRisk,
              pool_id: p.pool,
            })),
            matched: matched.length,
            total_pools: all.length,
          } as unknown as JsonObject;
        },
      };
    }
    // ── DEX volume and protocol fees ────────────────────────────────────
    case 'dex_volume_overview':
    case 'protocol_fees_overview': {
      const isFees = fn === 'protocol_fees_overview';
      const chain = str(input, 'chain');
      const limit = num(input, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
      const path = isFees ? 'overview/fees' : 'overview/dexs';
      return {
        // The charts are what make these responses tens of megabytes, and the
        // vendor can leave them out.
        url: `${TVL_BASE}/${path}${chain ? `/${encodeURIComponent(chain.trim())}` : ''}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`,
        shape: (body) => {
          const b = (body ?? {}) as { total24h?: number; total7d?: number; change_1d?: number; protocols?: Array<Record<string, unknown>> };
          const rows = (b.protocols ?? []).map((p) => compact({
            name: p.name,
            category: p.category,
            chains: Array.isArray(p.chains) ? (p.chains as string[]).slice(0, 8) : undefined,
            [isFees ? 'fees_24h_usd' : 'volume_24h_usd']: nOf(p.total24h),
            [isFees ? 'fees_7d_usd' : 'volume_7d_usd']: nOf(p.total7d),
            [isFees ? 'revenue_24h_usd' : 'volume_30d_usd']: nOf(isFees ? p.revenue24h : p.total30d),
            change_1d_pct: nOf(p.change_1d),
          }));
          rows.sort((a, b2) => {
            const key = isFees ? 'fees_24h_usd' : 'volume_24h_usd';
            return ((b2 as Record<string, number>)[key] ?? 0) - ((a as Record<string, number>)[key] ?? 0);
          });
          return compact({
            chain: chain ?? 'all chains',
            total_24h_usd: nOf(b.total24h),
            total_7d_usd: nOf(b.total7d),
            change_1d_pct: nOf(b.change_1d),
            protocols: rows.slice(0, limit),
            total_protocols: (b.protocols ?? []).length,
          });
        },
      };
    }
    case 'dex_protocol_volume':
    case 'protocol_fees': {
      const isFees = fn === 'protocol_fees';
      const protocol = str(input, 'protocol');
      if (!protocol) return { error: 'protocol is required (the protocol name or slug, e.g. "uniswap")' };
      const points = num(input, 'points', DEFAULT_HISTORY_POINTS, MAX_HISTORY_POINTS);
      const path = isFees ? 'summary/fees' : 'summary/dexs';
      return {
        url: `${TVL_BASE}/${path}/${slug(protocol)}?excludeTotalDataChartBreakdown=true`,
        shape: (body) => {
          const b = (body ?? {}) as {
            name?: string; category?: string; chains?: string[]; total24h?: number; total7d?: number;
            total30d?: number; totalAllTime?: number; change_1d?: number; revenue24h?: number;
            totalDataChart?: Array<[number, number]>;
          };
          const series = Array.isArray(b.totalDataChart) ? b.totalDataChart : [];
          return compact({
            protocol: b.name ?? protocol,
            category: b.category,
            chains: Array.isArray(b.chains) ? b.chains.slice(0, 12) : undefined,
            [isFees ? 'fees_24h_usd' : 'volume_24h_usd']: nOf(b.total24h),
            [isFees ? 'fees_7d_usd' : 'volume_7d_usd']: nOf(b.total7d),
            [isFees ? 'fees_30d_usd' : 'volume_30d_usd']: nOf(b.total30d),
            [isFees ? 'fees_all_time_usd' : 'volume_all_time_usd']: nOf(b.totalAllTime),
            revenue_24h_usd: isFees ? nOf(b.revenue24h) : undefined,
            change_1d_pct: nOf(b.change_1d),
            daily_points: tail(series, points).map(([date, value]) => ({ date, [isFees ? 'fees_usd' : 'volume_usd']: value })),
            points_available: series.length,
          });
        },
      };
    }
    default:
      return { error: `defillama has no tool named ${fn}` };
  }
}

const transport = makePublicWebTransport('defillama', DEFAULT_PUBLIC_WEB_HEADERS);

export async function defillamaExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const input = (ctx.input ?? {}) as JsonObject;
  const route = routeFor(ctx.functionName, input);
  if ('error' in route) return { result: {}, failure: { message: `defillama ${ctx.functionName}: ${route.error}` } };

  const started = Date.now();
  try {
    const resp = await transport({ method: 'GET', url: route.url });
    const vendorLatencyMs = Date.now() - started;
    if (!resp.ok) {
      // A name the source does not know answers 400 on some routes and 404 on
      // others (measured: /tvl/<unknown> is 400), and neither carries a body
      // worth relaying; a 429 is the shared rate limit on the free tier.
      const detail = resp.status === 400 || resp.status === 404
        ? 'the source has no record under that name (check the protocol, chain or token id)'
        : resp.status === 429
          ? 'the source is rate-limiting this request; try again shortly'
          : `HTTP ${resp.status}`;
      return { result: {}, vendorLatencyMs, failure: { message: `defillama ${ctx.functionName} failed: ${detail}` } };
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return { result: {}, vendorLatencyMs, failure: { message: `defillama ${ctx.functionName}: the source answered with something that is not JSON` } };
    }
    // Free public source: no per-call charge to attribute.
    return { result: route.shape(body, input), vendorLatencyMs, costUsd: 0 };
  } catch (err) {
    return {
      result: {},
      vendorLatencyMs: Date.now() - started,
      failure: { message: `defillama ${ctx.functionName} request failed: ${(err as Error).message}` },
    };
  }
}

registerConnectorExecutor('defillama', defillamaExecutor);
