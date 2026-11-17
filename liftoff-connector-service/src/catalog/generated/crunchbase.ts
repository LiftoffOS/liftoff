// FALLBACK-AUTHORED registry functions — Crunchbase REST API v4.
// Basis: data.crunchbase.com API v4 documentation (entity lookup, search,
// autocomplete), 2026-09-08. The official OpenAPI requires a licensed
// account to download; REGENERATE through scripts/generate-registry once one
// exists. Hand-fixes meanwhile follow the same overrides discipline as
// generated vendors: edit here only to correct against the vendor's own docs.
//
// Crunchbase is a VISIBLE BYO-key connector: full REST v4 access requires the
// customer's own Enterprise or Applications license key. There is no platform
// credential, so resolution is tenant-key-or-unavailable.

import type { ConnectorFunction } from '../../types.js';

export const CRUNCHBASE_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'get_organization',
    description: 'Look up one organization by its Crunchbase permalink, with funding, categories, and location fields',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Organization permalink or UUID' },
        field_ids: { type: 'string', description: 'Comma-separated fields to include' },
      },
      required: ['entity_id'],
    },
    categories: ['read'],
  },
  {
    name: 'get_person',
    description: 'Look up one person by Crunchbase permalink, with roles and investments',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Person permalink or UUID' },
        field_ids: { type: 'string', description: 'Comma-separated fields to include' },
      },
      required: ['entity_id'],
    },
    categories: ['read'],
  },
  {
    name: 'get_funding_round',
    description: 'Look up one funding round by UUID, with investors and amounts',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Funding round UUID' },
      },
      required: ['entity_id'],
    },
    categories: ['read'],
  },
  {
    name: 'search_organizations',
    description: 'Search organizations by name, category, location, or funding criteria',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text' },
        limit: { type: 'number', description: 'Maximum results, up to 50' },
      },
      required: ['query'],
    },
    categories: ['read'],
  },
  {
    name: 'search_funding_rounds',
    description: 'Search funding rounds by date, amount, or investor criteria',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text' },
        limit: { type: 'number', description: 'Maximum results, up to 50' },
      },
      required: ['query'],
    },
    categories: ['read'],
  },
  {
    name: 'autocomplete',
    description: 'Resolve a free-text name to Crunchbase entities with permalinks',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment to resolve' },
        collection_ids: { type: 'string', description: 'Restrict to collections, e.g. organizations' },
      },
      required: ['query'],
    },
    categories: ['read'],
  },
];
