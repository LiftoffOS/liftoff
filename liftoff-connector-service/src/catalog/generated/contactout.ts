// FALLBACK-AUTHORED registry functions — ContactOut API.
// Basis: contactout.com API documentation surface, 2026-09-08. No public
// OpenAPI spec exists; REGENERATE through scripts/generate-registry if the
// vendor publishes one. ContactOut is a VISIBLE BYO-key connector (the API
// plan is sales-gated); resolution is tenant-key-or-unavailable.

import type { ConnectorFunction } from '../../types.js';

export const CONTACTOUT_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'enrich_from_linkedin_url',
    description: 'Resolve a LinkedIn profile URL to verified emails and phone numbers',
    inputSchema: {
      type: 'object',
      properties: {
        profile_url: { type: 'string', description: 'LinkedIn profile URL' },
      },
      required: ['profile_url'],
    },
    categories: ['read', 'sensitive'],
  },
  {
    name: 'enrich_from_email',
    description: 'Resolve an email address to a person profile with role and company',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address to look up' },
      },
      required: ['email'],
    },
    categories: ['read', 'sensitive'],
  },
  {
    name: 'search_people',
    description: 'Search professional profiles by name, title, company, or location',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Person name' },
        job_title: { type: 'string', description: 'Job title filter' },
        company: { type: 'string', description: 'Company filter' },
        location: { type: 'string', description: 'Location filter' },
        limit: { type: 'number', description: 'Maximum results' },
      },
    },
    categories: ['read', 'sensitive'],
  },
  {
    name: 'get_email_status',
    description: 'Check the deliverability status of an email address',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address to verify' },
      },
      required: ['email'],
    },
    categories: ['read'],
  },
];
