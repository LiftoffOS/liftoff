// Nasdaq market-data native executor — the public nasdaq.com web API.
//
// This is NOT the Quandl-era Data Link dataset API (data.nasdaq.com/api/v3),
// which is subscription-gated and, as of the 2026 retirement, answers every
// server egress with an Incapsula bot-challenge before the key is read. The
// capability worth having is the market data behind nasdaq.com itself: live
// stock/ETF/fund/crypto quotes, company financials, earnings, dividends,
// options, screeners and movers. That surface is a keyless public JSON API
// (the same one the website calls), so this executor is credential-free and
// rides the public-web transport with browser-shaped headers.
//
// Two hosts: most routes are on api.nasdaq.com; news alone is served from
// www.nasdaq.com. The vendor wraps every JSON response in a
// { data, message, status: { rCode, bCodeMessage } } envelope and answers a
// bad request with HTTP 200 + rCode != 200 — so success is read off rCode, not
// resp.ok. A real HTTP 403 (or a non-JSON body) is the bot-management edge
// refusing the egress; that is reported as unavailable, never as a permissions
// problem, because no grant or subscription can clear it.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ExecutorContext, ExecutorResult } from '../rpc/execute-dispatcher.js';
import { registerConnectorExecutor } from '../rpc/execute-dispatcher.js';
import { makePublicWebTransport, DEFAULT_PUBLIC_WEB_HEADERS } from './connector-transport.js';

const API_BASE = 'https://api.nasdaq.com/api';
const NEWS_BASE = 'https://www.nasdaq.com/api';

// nasdaq.com's own site headers. Origin/Referer are vendor-specific, so they
// are set here on top of the generic browser defaults.
const NASDAQ_HEADERS: Record<string, string> = {
  ...DEFAULT_PUBLIC_WEB_HEADERS,
  Origin: 'https://www.nasdaq.com',
  Referer: 'https://www.nasdaq.com/',
};

type AssetClass = 'stocks' | 'etf' | 'mutualfunds' | 'crypto' | 'index';

function str(input: JsonObject, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(input: JsonObject, key: string): number | undefined {
  const v = input[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

// A ticker goes into the URL PATH, so anything outside the vendor's own symbol
// alphabet is refused rather than encoded — a crafted symbol cannot turn into
// path traversal. Nasdaq symbols are letters, digits, '.' (class shares like
// BRK.A) and '-'; nothing else, and never a bare dot segment.
function safeSymbol(sym: string | undefined): string | undefined {
  if (!sym) return undefined;
  const s = sym.trim().toUpperCase();
  if (!/^[A-Z0-9.-]{1,15}$/.test(s) || s === '.' || s === '..') return undefined;
  return s;
}

interface Route {
  host: string;
  path: string;
  query: URLSearchParams;
}

function routeFor(ctx: ExecutorContext): Route | { error: string } {
  const input = ctx.input;
  const q = new URLSearchParams();

  // Shared helper: a per-symbol quote at a fixed asset class.
  const quoteRoute = (assetclass: AssetClass): Route | { error: string } => {
    const sym = safeSymbol(str(input, 'symbol'));
    if (!sym) return { error: 'symbol is required' };
    q.set('assetclass', assetclass);
    return { host: API_BASE, path: `/quote/${sym}/info`, query: q };
  };

  switch (ctx.functionName) {
    case 'get_stock_quote':
      return quoteRoute('stocks');
    case 'get_etf_quote':
      return quoteRoute('etf');
    case 'get_mutual_fund_quote':
      return quoteRoute('mutualfunds');
    case 'get_cryptocurrency_quote':
      return quoteRoute('crypto');

    case 'get_historical_quotes': {
      const sym = safeSymbol(str(input, 'symbol'));
      if (!sym) return { error: 'symbol is required' };
      q.set('assetclass', str(input, 'asset_class') ?? 'stocks');
      const from = str(input, 'from_date');
      const to = str(input, 'to_date');
      if (from) q.set('fromdate', from);
      if (to) q.set('todate', to);
      q.set('limit', String(num(input, 'limit') ?? 100));
      return { host: API_BASE, path: `/quote/${sym}/historical`, query: q };
    }

    case 'get_dividend_history': {
      const sym = safeSymbol(str(input, 'symbol'));
      if (!sym) return { error: 'symbol is required' };
      q.set('assetclass', str(input, 'asset_class') ?? 'stocks');
      return { host: API_BASE, path: `/quote/${sym}/dividends`, query: q };
    }

    case 'get_company_financials': {
      const sym = safeSymbol(str(input, 'symbol'));
      if (!sym) return { error: 'symbol is required' };
      // 1 = annual, 2 = quarterly (the vendor's own frequency codes).
      q.set('frequency', String(num(input, 'frequency') ?? 1));
      return { host: API_BASE, path: `/company/${sym}/financials`, query: q };
    }

    case 'get_earnings_calendar': {
      const date = str(input, 'date');
      if (!date) return { error: 'date is required (YYYY-MM-DD)' };
      q.set('date', date);
      return { host: API_BASE, path: '/calendar/earnings', query: q };
    }

    case 'get_sec_filings': {
      const sym = safeSymbol(str(input, 'symbol'));
      if (!sym) return { error: 'symbol is required' };
      q.set('limit', String(num(input, 'limit') ?? 20));
      q.set('sortColumn', 'filed');
      q.set('sortOrder', 'desc');
      q.set('IsQuote', 'true');
      return { host: API_BASE, path: `/company/${sym}/sec-filings`, query: q };
    }

    case 'get_institutional_holdings': {
      const sym = safeSymbol(str(input, 'symbol'));
      if (!sym) return { error: 'symbol is required' };
      q.set('limit', String(num(input, 'limit') ?? 20));
      q.set('type', 'TOTAL');
      q.set('sortColumn', 'marketValue');
      q.set('sortOrder', 'DESC');
      return { host: API_BASE, path: `/company/${sym}/institutional-holdings`, query: q };
    }

    case 'get_insider_trades': {
      const sym = safeSymbol(str(input, 'symbol'));
      if (!sym) return { error: 'symbol is required' };
      q.set('limit', String(num(input, 'limit') ?? 20));
      q.set('type', 'ALL');
      q.set('sortColumn', 'lastDate');
      q.set('sortOrder', 'DESC');
      return { host: API_BASE, path: `/company/${sym}/insider-trades`, query: q };
    }

    case 'get_short_interest': {
      const sym = safeSymbol(str(input, 'symbol'));
      if (!sym) return { error: 'symbol is required' };
      q.set('assetClass', str(input, 'asset_class') ?? 'stocks');
      return { host: API_BASE, path: `/quote/${sym}/short-interest`, query: q };
    }

    case 'get_option_chain': {
      const sym = safeSymbol(str(input, 'symbol'));
      if (!sym) return { error: 'symbol is required' };
      q.set('assetclass', str(input, 'asset_class') ?? 'stocks');
      q.set('limit', String(num(input, 'limit') ?? 25));
      q.set('fromdate', 'all');
      q.set('todate', 'undefined');
      q.set('excode', 'oprac');
      q.set('callput', 'callput');
      q.set('money', str(input, 'moneyness') ?? 'all');
      q.set('type', 'all');
      return { host: API_BASE, path: `/quote/${sym}/option-chain`, query: q };
    }

    case 'get_stock_screener': {
      q.set('tableonly', 'true');
      q.set('limit', String(num(input, 'limit') ?? 25));
      q.set('offset', String(num(input, 'offset') ?? 0));
      q.set('download', 'true');
      const search = str(input, 'search');
      if (search) q.set('search', search);
      const exchange = str(input, 'exchange');
      if (exchange) q.set('exchange', exchange);
      const sector = str(input, 'sector');
      if (sector) q.set('sector', sector);
      return { host: API_BASE, path: '/screener/stocks', query: q };
    }

    case 'get_market_indices':
      q.set('tableonly', 'true');
      return { host: API_BASE, path: '/screener/index', query: q };

    case 'get_market_movers':
      return { host: API_BASE, path: '/marketmovers', query: q };

    case 'search_symbols': {
      const search = str(input, 'query') ?? str(input, 'search');
      if (!search) return { error: 'query is required' };
      q.set('search', search);
      const limit = num(input, 'limit') ?? 10;
      return { host: API_BASE, path: `/autocomplete/slookup/${limit}`, query: q };
    }

    case 'get_market_info':
      return { host: API_BASE, path: '/market-info', query: q };

    case 'get_stock_news': {
      const sym = safeSymbol(str(input, 'symbol'));
      if (!sym) return { error: 'symbol is required' };
      // News lives on www.nasdaq.com, and its filter is `SYMBOL|assetclass`.
      q.set('q', `${sym}|${str(input, 'asset_class') ?? 'stocks'}`);
      q.set('offset', String(num(input, 'offset') ?? 0));
      q.set('limit', String(num(input, 'limit') ?? 10));
      q.set('fallback', 'true');
      return { host: NEWS_BASE, path: '/news/topic/articlebysymbol', query: q };
    }

    default:
      return { error: `nasdaq has no operation named ${ctx.functionName}` };
  }
}

interface NasdaqEnvelope {
  data?: unknown;
  message?: string | null;
  status?: {
    rCode?: number;
    bCodeMessage?: Array<{ code?: number; errorMessage?: string }> | null;
  };
}

export async function nasdaqExecutor(ctx: ExecutorContext): Promise<ExecutorResult> {
  const route = routeFor(ctx);
  if ('error' in route) {
    return { result: {}, failure: { message: route.error } };
  }

  const transport = makePublicWebTransport('nasdaq', NASDAQ_HEADERS);
  const started = Date.now();
  try {
    const resp = await transport({
      method: 'GET',
      url: `${route.host}${route.path}?${route.query.toString()}`,
    });
    const vendorLatencyMs = Date.now() - started;

    // The bot-management edge answers a distrusted egress with an HTML
    // challenge (HTTP 403), not the JSON envelope. No key or subscription
    // clears that, so it must read as unavailable — retryable and truthful —
    // rather than a permissions failure ("ask the user for access").
    let body: NasdaqEnvelope;
    try {
      body = (await resp.json()) as NasdaqEnvelope;
    } catch {
      return {
        result: {},
        vendorLatencyMs,
        failure: {
          message:
            `nasdaq ${route.path}: the vendor's edge refused the request before it reached the `
            + 'API (bot filter) — unavailable from this network egress, not an authorization failure',
        },
      };
    }
    if (resp.status === 403) {
      return {
        result: {},
        vendorLatencyMs,
        failure: {
          message:
            `nasdaq ${route.path}: the vendor's edge refused the request (403 bot filter) — `
            + 'unavailable from this network egress, not an authorization failure',
        },
      };
    }

    const rCode = body.status?.rCode;
    if (rCode !== undefined && rCode !== 200) {
      const detail = body.status?.bCodeMessage?.map((b) => b.errorMessage).filter(Boolean).join('; ')
        || body.message
        || 'request rejected';
      return {
        result: (body as unknown as JsonObject) ?? {},
        vendorLatencyMs,
        failure: { message: `nasdaq ${route.path} returned rCode ${rCode}: ${detail}` },
      };
    }

    // Free public source: no per-call charge to attribute.
    return {
      result: (body as unknown as JsonObject) ?? {},
      vendorLatencyMs,
      costUsd: 0,
    };
  } catch (err) {
    return {
      result: {},
      vendorLatencyMs: Date.now() - started,
      failure: { message: `nasdaq request failed: ${(err as Error).message}` },
    };
  }
}

registerConnectorExecutor('nasdaq', nasdaqExecutor);
