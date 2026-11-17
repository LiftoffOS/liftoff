// FALLBACK-AUTHORED registry functions — the Y Combinator company directory,
// read from YC's own public API (api.ycombinator.com/v0.1/companies, keyless,
// verified live 2026-09-22). Two functions: search the directory with the
// filters the API takes, and one company's profile by its slug. The API lists
// companies only — founders, partners and job listings are not on it — so a
// need for those is a different capability, not a gap in this one. Each is a
// case in src/clients/ycombinator.ts; both are free at the source, so a call
// costs nothing and books nothing. All read-only.

import type { ConnectorFunction } from '../../types.js';

export const YCOMBINATOR_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'yc_companies_search',
    description: 'Search the Y Combinator company directory by keyword, batch, industry and status; each result carries the company slug, one-liner, description, batch, team size, industries, tags, locations, website and whether it is hiring or a top company',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to match against company name, description and tags' },
        batch: { type: 'string', description: "YC batch code, e.g. 'W24', 'S23', 'X25'" },
        industry: { type: 'string', description: "Industry, e.g. 'Fintech', 'B2B', 'Healthcare', 'Consumer'" },
        status: { type: 'string', description: "'Active', 'Acquired', 'Public' or 'Inactive'" },
        page: { type: 'integer', description: 'Page number, from 1 (20 companies a page)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'yc_company_profile',
    description: "One Y Combinator company's directory profile by its slug: description, batch, team size, status, industries, tags, locations, website and badges",
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: "The company slug from yc_companies_search or its ycombinator.com/companies URL, e.g. 'stripe', 'airbnb'" } },
      required: ['slug'],
    },
    categories: ['read'],
  },
];
