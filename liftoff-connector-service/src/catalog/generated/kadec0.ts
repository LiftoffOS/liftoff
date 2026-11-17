// FALLBACK-AUTHORED registry functions — kadec0 web search & data API
// (api.kadec0.xyz).
//
// Basis: the vendor's own machine-readable index at https://api.kadec0.xyz/
// (GET /), fetched live 2026-09-10 — 44 keyless GET endpoints, each priced
// per call and paid via x402 (v2, USDC on Base, CDP facilitator). CURATED to
// the 10 head tools below (the tikhub discipline: serve the surface worth
// classifying, not everything the vendor lists); several of the remaining 34
// duplicate surfaces we already serve elsewhere (Google Trends via
// google_trends, weather/quakes/nutrition niches). Add a tool by extending
// BOTH lists here and seeding its classification in platform-backend.
// Prices are the vendor's declared per-call prices and feed the spend
// guard's per-call cap (×2). All read-only.

import type { ConnectorFunction } from '../../types.js';

export const KADEC0_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'search_web_serp',
    description: 'Keyless multi-backend web search returning title, URL and snippet per result',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query' },
        num_results: { type: 'number', description: 'Number of results' },
        region: { type: 'string', description: "Region code, e.g. 'us-en'" },
        mode: { type: 'string', description: "'web' or 'news'" },
      },
      required: ['q'],
    },
    categories: ['read'],
  },
  {
    name: 'scrape_url_markdown',
    description: 'Fetch a URL and return clean markdown plus structured data',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to scrape' },
        maxChars: { type: 'number', description: 'Truncate the markdown at this length' },
      },
      required: ['url'],
    },
    categories: ['read'],
  },
  {
    name: 'get_market_sentiment',
    description: 'Aggregated market fear/greed reading: CNN Fear & Greed, crypto Fear & Greed and VIX',
    inputSchema: {
      type: 'object',
      properties: {
        asset_class: { type: 'string', description: "'crypto' or 'stocks'" },
      },
    },
    categories: ['read'],
  },
  {
    name: 'search_sec_filings',
    description: 'SEC EDGAR filings full-text search by query, company or CIK',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Full-text query' },
        company: { type: 'string', description: 'Company name' },
        cik: { type: 'string', description: 'SEC CIK number' },
        type: { type: 'string', description: "Filing type, e.g. '10-K'" },
        dateRange: { type: 'string', description: 'Date range filter' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'get_congress_trades',
    description: 'US congressional stock trades (House and Senate, STOCK Act disclosures)',
    inputSchema: {
      type: 'object',
      properties: {
        politician: { type: 'string', description: 'Politician name filter' },
        ticker: { type: 'string', description: 'Ticker filter' },
        chamber: { type: 'string', description: "'house' or 'senate'" },
      },
    },
    categories: ['read'],
  },
  {
    name: 'get_defi_tvl',
    description: 'DeFi protocol and chain TVL via DefiLlama',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: "'protocols' or 'chains'" },
        q: { type: 'string', description: 'Protocol/chain name filter' },
        category: { type: 'string', description: 'Protocol category filter' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'get_token_price',
    description: 'Crypto token price and market data via CoinPaprika',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'string', description: 'Coin ids or symbols, comma-separated' },
      },
      required: ['ids'],
    },
    categories: ['read'],
  },
  {
    name: 'search_academic_papers',
    description: 'Unified academic search across arXiv, PubMed, OpenAlex, Crossref and Semantic Scholar, deduplicated',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query' },
      },
      required: ['q'],
    },
    categories: ['read'],
  },
  {
    name: 'get_domain_info',
    description: 'WHOIS and DNS records for a domain',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain name' },
      },
      required: ['domain'],
    },
    categories: ['read'],
  },
  {
    name: 'validate_email_address',
    description: 'Email validation: RFC syntax, MX lookup, disposable-domain, role-account and free-provider checks',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address to validate' },
      },
      required: ['email'],
    },
    categories: ['read'],
  },
];

/** Path + declared per-call price for each tool, co-generated with the
 *  function list above so the two cannot drift apart. */
export const KADEC0_DISPATCH: Record<string, { path: string; priceUsd: number }> = {
  search_web_serp: { path: '/v1/serp', priceUsd: 0.05 },
  scrape_url_markdown: { path: '/v1/scrape', priceUsd: 0.03 },
  get_market_sentiment: { path: '/v1/market-sentiment', priceUsd: 0.05 },
  search_sec_filings: { path: '/v1/sec-edgar', priceUsd: 0.05 },
  get_congress_trades: { path: '/v1/congress-trades', priceUsd: 0.05 },
  get_defi_tvl: { path: '/v1/defi-tvl', priceUsd: 0.02 },
  get_token_price: { path: '/v1/token-price', priceUsd: 0.01 },
  search_academic_papers: { path: '/v1/papers', priceUsd: 0.02 },
  get_domain_info: { path: '/v1/domain-info', priceUsd: 0.02 },
  validate_email_address: { path: '/v1/email-validate', priceUsd: 0.03 },
};
