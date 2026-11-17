// FALLBACK-AUTHORED registry functions — Gloria (itsgloria.ai).
// Basis: Gloria's public MCP server tool list at https://mcp.itsgloria.ai/mcp
// (streamable-HTTP), enumerated live 2026-09-10. The first 5 are the FREE
// tools the native MCP executor (src/clients/gloria-mcp.ts) serves with no
// credential; the last 2 (get_enriched_news, get_ticker_summary) are gloria's
// x402-gated premium tools, served through the x402 transport — the tool call
// is paid per call in USDC from the platform wallet. Names match the MCP tool
// names exactly so functionName maps straight through. All read-only.

import type { ConnectorFunction } from '../../types.js';

export const GLORIA_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'get_categories',
    description: 'List the available news category codes (e.g. bitcoin, ethereum, defi, ai, macro)',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'get_latest_news',
    description: 'Latest curated crypto news headlines with sentiment, categories, and sources',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: "Filter by category code (e.g. 'bitcoin', 'defi'); omit for all" },
        limit: { type: 'number', description: 'Number of items, 1-10 (default 5)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'get_news_recap',
    description: 'AI-generated narrative recap of recent news for a category',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: "Category code, e.g. 'crypto', 'bitcoin', 'macro'" },
        timeframe: { type: 'string', description: 'Recap window (optional)' },
      },
      required: ['category'],
    },
    categories: ['read'],
  },
  {
    name: 'search_news',
    description: 'Search recent news by free-text query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text' },
        limit: { type: 'number', description: 'Maximum items' },
      },
      required: ['query'],
    },
    categories: ['read'],
  },
  {
    name: 'get_news_item',
    description: 'Fetch a single news item by its id',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'News item id' },
      },
      required: ['id'],
    },
    categories: ['read'],
  },
  // ── Premium tools (REST endpoints on api.itsgloria.ai; paid per call ──
  // from the platform wallet via x402, or served on a tenant's own Elite
  // bearer). Param names and requiredness are the endpoints' OWN declarations,
  // read off their live 402 challenges (outputSchema.input, 2026-09-10).
  {
    name: 'get_enriched_news',
    description: 'Premium enriched crypto news: full articles with AI enrichment, entities, and market context',
    inputSchema: {
      type: 'object',
      properties: {
        feed_categories: { type: 'string', description: "Comma-separated category codes (e.g. 'bitcoin', 'defi', 'ai', 'macro', 'solana')" },
        from_date: { type: 'string', description: 'Earliest date, YYYY-MM-DD (optional)' },
        to_date: { type: 'string', description: 'Latest date, YYYY-MM-DD (optional)' },
        limit: { type: 'number', description: 'Number of items, 1-10 (default 10)' },
        page: { type: 'number', description: 'Page number (default 1)' },
      },
      required: ['feed_categories'],
    },
    categories: ['read'],
  },
  {
    name: 'get_ticker_summary',
    description: 'Premium AI summary of recent news and sentiment for a single ticker or asset',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: "Ticker symbol or topic name, e.g. 'BTC', 'SOL', 'LayerZero'" },
      },
      required: ['ticker'],
    },
    categories: ['read'],
  },
];
