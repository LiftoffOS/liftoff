// FALLBACK-AUTHORED registry functions — Browserbase pay-per-use gateway
// (x402.browserbase.com).
//
// Basis: the gateway's own index page and the input schemas its 402
// challenges declare (outputSchema.input), probed live 2026-09-10. This is
// browserbase's PAY-PER-CALL surface — no API key, no account; each call's
// 402 is paid in USDC from the platform wallet. It speaks x402Version 1
// (network name 'base'), which the shared transport also registers.
//
// DELIBERATELY EXCLUDED: the /browser/session/* endpoints (create/extend at
// $0.12/hour). A browser session is a resource the tenant runtime's browser
// stack owns end to end — a connect URL returned as a tool result would hand
// the agent a session nothing in the platform drives. If browserbase x402
// sessions ever land, they land through the browser-vendor architecture, not
// as a catalog tool here.
//
// The two request/response tools below are the honest per-call surface.
// Distinct from the BYOK 'browserbase' web-tool connector (a tenant's own
// key, driven from tenant-runtime): this type is 'browserbase_x402'.

import type { ConnectorFunction } from '../../types.js';

export const BROWSERBASE_X402_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'search_the_web',
    description: 'Web search with structured results (title, URL, snippet) via the Browserbase pay-per-use gateway',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (1-200 chars)' },
        numResults: { type: 'number', description: 'Number of results (1-25, default 10)' },
      },
      required: ['query'],
    },
    categories: ['read'],
  },
  {
    name: 'fetch_page_content',
    description: 'Fetch a web page and return its content, status and metadata via the Browserbase pay-per-use gateway',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        allowRedirects: { type: 'boolean', description: 'Follow HTTP redirects (default false)' },
      },
      required: ['url'],
    },
    categories: ['read'],
  },
];

/** Path + declared per-call price for each tool, co-generated with the
 *  function list above so the two cannot drift apart. */
export const BROWSERBASE_X402_DISPATCH: Record<string, { path: string; priceUsd: number }> = {
  search_the_web: { path: '/search', priceUsd: 0.01 },
  fetch_page_content: { path: '/fetch', priceUsd: 0.01 },
};
