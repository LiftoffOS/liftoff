// FALLBACK-AUTHORED registry functions — Google Trends via the x402 Atlas
// (google-trends.use.x402atlas.com).
//
// Basis: the vendor's own machine-readable index at
// https://google-trends.use.x402atlas.com/ (GET /), fetched live 2026-09-10 —
// endpoint paths, prices and descriptions are the vendor's declarations,
// verbatim where they fit. Every tool is a keyless GET whose 402 challenge
// the x402 transport pays per call (x402 v2, USDC on Base); prices below are
// the DECLARED per-call prices and feed the spend guard's per-call cap (×2).
// All read-only.

import type { ConnectorFunction } from '../../types.js';

export const GOOGLE_TRENDS_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'get_keyword_trend',
    description: 'Google Trends interest over time for a keyword — worldwide search popularity as a monthly series for keyword research, SEO and demand trend analysis',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The search keyword' },
      },
      required: ['keyword'],
    },
    categories: ['read'],
  },
  {
    name: 'get_keyword_interest_by_region',
    description: 'Google Trends interest by region for a keyword — search popularity by geography for geo-targeting, local SEO and market research',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The search keyword' },
        country: { type: 'string', description: "Two-letter country code, e.g. 'us'" },
      },
      required: ['keyword', 'country'],
    },
    categories: ['read'],
  },
  {
    name: 'get_keyword_related_queries',
    description: 'Google Trends related search queries for a keyword by country — top and rising terms for SEO keyword research, query expansion and content ideas',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The search keyword' },
        country: { type: 'string', description: "Two-letter country code, e.g. 'us'" },
      },
      required: ['keyword', 'country'],
    },
    categories: ['read'],
  },
  {
    name: 'get_keyword_related_topics',
    description: 'Google Trends related topics for a keyword by country — top and rising topics for SEO content research, trend discovery and market analysis',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'The search keyword' },
        country: { type: 'string', description: "Two-letter country code, e.g. 'us'" },
      },
      required: ['keyword', 'country'],
    },
    categories: ['read'],
  },
];

/** Path + declared per-call price for each tool, co-generated with the
 *  function list above so the two cannot drift apart. */
export const GOOGLE_TRENDS_DISPATCH: Record<string, { path: string; priceUsd: number }> = {
  get_keyword_trend: { path: '/trend', priceUsd: 0.05 },
  get_keyword_interest_by_region: { path: '/interest-by-region', priceUsd: 0.03 },
  get_keyword_related_queries: { path: '/related-queries', priceUsd: 0.03 },
  get_keyword_related_topics: { path: '/related-topics', priceUsd: 0.03 },
};
