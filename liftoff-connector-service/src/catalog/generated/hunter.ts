// Registry functions + dispatch — Hunter.io (hunter.io), native REST executor.
//
// Hunter exposes both a 101-tool MCP (mcp.hunter.io/mcp) and a clean REST API
// (api.hunter.io/v2). The MCP's surface is ~90% CRM/campaign management (leads,
// sequences, lists, templates, webhooks, API keys — many destructive); the
// lead-gen VALUE is the enrichment/search core, which is a small, clean REST
// surface. So this is a native REST executor over that curated set — bypassing
// Composio, and exposing only the data capabilities, not the CRM management.
//
// Auth is Hunter's `?api_key=` query parameter (not a bearer), so the executor
// uses the public-web transport and appends the key. Every function here is a
// READ (a data lookup); Hunter charges CREDITS per call (email-count and
// account are free), which is a balance concern handled by fail-closed + the
// account/usage read, not a gating one.

import type { ConnectorFunction } from '../../types.js';

/** functionName -> REST method + path. GET passes inputs as query params, POST
 *  as the JSON body; the api_key rides in the query either way. */
export const HUNTER_DISPATCH: Record<string, { method: 'GET' | 'POST'; path: string }> = {
  domain_search: { method: 'GET', path: '/v2/domain-search' },
  email_finder: { method: 'GET', path: '/v2/email-finder' },
  email_verifier: { method: 'GET', path: '/v2/email-verifier' },
  email_count: { method: 'GET', path: '/v2/email-count' },
  company_enrichment: { method: 'GET', path: '/v2/companies/find' },
  person_enrichment: { method: 'GET', path: '/v2/people/find' },
  combined_enrichment: { method: 'GET', path: '/v2/combined/find' },
  find_people: { method: 'POST', path: '/v2/discover' },
  get_account: { method: 'GET', path: '/v2/account' },
};

export const HUNTER_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'domain_search',
    description: 'Find the email addresses associated with a domain, with names, roles, and confidence',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The domain to search, e.g. stripe.com' },
        limit: { type: 'number', description: 'Max emails to return (default 10)' },
        type: { type: 'string', description: "'personal' or 'generic' (optional)" },
        seniority: { type: 'string', description: "Comma-separated: junior, senior, executive (optional)" },
        department: { type: 'string', description: 'Comma-separated department filter (optional)' },
      },
      required: ['domain'],
    },
    categories: ['read'],
  },
  {
    name: 'email_finder',
    description: "Find a specific person's email address at a domain by their name",
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Company domain, e.g. stripe.com' },
        full_name: { type: 'string', description: "The person's full name" },
        first_name: { type: 'string', description: 'First name (alternative to full_name)' },
        last_name: { type: 'string', description: 'Last name (alternative to full_name)' },
      },
      required: ['domain'],
    },
    categories: ['read'],
  },
  {
    name: 'email_verifier',
    description: 'Verify the deliverability and validity of an email address',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'The email address to verify' } },
      required: ['email'],
    },
    categories: ['read'],
  },
  {
    name: 'email_count',
    description: 'Count the known email addresses for a domain (free, no credit)',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The domain to count, e.g. stripe.com' },
        type: { type: 'string', description: "'personal' or 'generic' (optional)" },
      },
      required: ['domain'],
    },
    categories: ['read'],
  },
  {
    name: 'company_enrichment',
    description: 'Enrich a company by domain: industry, size, location, socials, tech',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'Company domain, e.g. stripe.com' } },
      required: ['domain'],
    },
    categories: ['read'],
  },
  {
    name: 'person_enrichment',
    description: 'Enrich a person by email: name, role, company, social profiles',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'The email address to enrich' } },
      required: ['email'],
    },
    categories: ['read'],
  },
  {
    name: 'combined_enrichment',
    description: 'Enrich both the person and their company from a single email',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'The email address to enrich' } },
      required: ['email'],
    },
    categories: ['read'],
  },
  {
    name: 'find_people',
    description: 'Discover people and companies matching criteria (uses a search credit)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of who to find' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Restrict to these company domains (optional)' },
        limit: { type: 'number', description: 'Max results (optional)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'get_account',
    description: 'Account plan and remaining credits/searches/verifications (free)',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
];
