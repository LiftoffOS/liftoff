// FALLBACK-AUTHORED registry functions — Nasdaq market data.
// Basis: nasdaq.com's public web JSON API (api.nasdaq.com, plus www.nasdaq.com
// for news), the surface behind the website itself. Routes were confirmed live
// 2026-09-09; there is no OpenAPI spec, so these are hand-authored to the
// executor in src/clients/nasdaq.ts and the two must stay in lock-step (each
// name below is a case there). Keyless public data — internal-tier, no vendor
// account or api key. All read-only.

import type { ConnectorFunction } from '../../types.js';

const SYMBOL = { type: 'string', description: 'Ticker symbol, for example AAPL' } as const;

export const NASDAQ_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'get_stock_quote',
    description: 'Latest price, change, and key stats for a stock',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL }, required: ['symbol'] },
    categories: ['read'],
  },
  {
    name: 'get_etf_quote',
    description: 'Latest quote for an ETF',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL }, required: ['symbol'] },
    categories: ['read'],
  },
  {
    name: 'get_mutual_fund_quote',
    description: 'Latest quote for a mutual fund',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL }, required: ['symbol'] },
    categories: ['read'],
  },
  {
    name: 'get_cryptocurrency_quote',
    description: 'Latest quote for a cryptocurrency, for example BTC',
    inputSchema: { type: 'object', properties: { symbol: SYMBOL }, required: ['symbol'] },
    categories: ['read'],
  },
  {
    name: 'get_historical_quotes',
    description: 'Historical daily OHLCV rows for a symbol over a date range',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL,
        asset_class: { type: 'string', description: 'stocks (default), etf, mutualfunds or crypto' },
        from_date: { type: 'string', description: 'Earliest date, YYYY-MM-DD' },
        to_date: { type: 'string', description: 'Latest date, YYYY-MM-DD' },
        limit: { type: 'number', description: 'Maximum rows (default 100)' },
      },
      required: ['symbol'],
    },
    categories: ['read'],
  },
  {
    name: 'get_dividend_history',
    description: 'Dividend yield, ex-dividend date, and payment history for a symbol',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, asset_class: { type: 'string', description: 'Defaults to stocks' } },
      required: ['symbol'],
    },
    categories: ['read'],
  },
  {
    name: 'get_company_financials',
    description: 'Income statement, balance sheet, and cash flow for a company',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL,
        frequency: { type: 'number', description: '1 = annual (default), 2 = quarterly' },
      },
      required: ['symbol'],
    },
    categories: ['read'],
  },
  {
    name: 'get_earnings_calendar',
    description: 'Companies reporting earnings on a given date',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'Calendar date, YYYY-MM-DD' } },
      required: ['date'],
    },
    categories: ['read'],
  },
  {
    name: 'get_sec_filings',
    description: 'Recent SEC filings for a company, newest first',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, limit: { type: 'number', description: 'Maximum filings (default 20)' } },
      required: ['symbol'],
    },
    categories: ['read'],
  },
  {
    name: 'get_institutional_holdings',
    description: 'Largest institutional holders of a symbol by market value',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, limit: { type: 'number', description: 'Maximum holders (default 20)' } },
      required: ['symbol'],
    },
    categories: ['read'],
  },
  {
    name: 'get_insider_trades',
    description: 'Recent insider buy and sell transactions for a symbol',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, limit: { type: 'number', description: 'Maximum trades (default 20)' } },
      required: ['symbol'],
    },
    categories: ['read'],
  },
  {
    name: 'get_short_interest',
    description: 'Short interest, days-to-cover, and settlement-date history for a symbol',
    inputSchema: {
      type: 'object',
      properties: { symbol: SYMBOL, asset_class: { type: 'string', description: 'Defaults to stocks' } },
      required: ['symbol'],
    },
    categories: ['read'],
  },
  {
    name: 'get_option_chain',
    description: 'Option chain (calls and puts) for a symbol',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL,
        asset_class: { type: 'string', description: 'Defaults to stocks' },
        moneyness: { type: 'string', description: 'all (default), in, out, or near' },
        limit: { type: 'number', description: 'Maximum contracts (default 25)' },
      },
      required: ['symbol'],
    },
    categories: ['read'],
  },
  {
    name: 'get_stock_screener',
    description: 'Screen stocks by exchange, sector, or free-text search',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Free-text company or ticker match' },
        exchange: { type: 'string', description: 'NASDAQ, NYSE or AMEX' },
        sector: { type: 'string', description: 'Sector filter' },
        limit: { type: 'number', description: 'Maximum rows (default 25)' },
        offset: { type: 'number', description: 'Row offset for paging (default 0)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'get_market_indices',
    description: 'Major market indices and their current levels',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'get_market_movers',
    description: 'Top gainers, losers, and most active across stocks, ETFs and funds',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'search_symbols',
    description: 'Look up ticker symbols by company name or partial ticker',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Company name or partial ticker' },
        limit: { type: 'number', description: 'Maximum matches (default 10)' },
      },
      required: ['query'],
    },
    categories: ['read'],
  },
  {
    name: 'get_market_info',
    description: 'Current U.S. market status and session open/close times',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'get_stock_news',
    description: 'Recent news articles for a symbol',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: SYMBOL,
        asset_class: { type: 'string', description: 'Defaults to stocks' },
        limit: { type: 'number', description: 'Maximum articles (default 10)' },
        offset: { type: 'number', description: 'Article offset for paging (default 0)' },
      },
      required: ['symbol'],
    },
    categories: ['read'],
  },
];
