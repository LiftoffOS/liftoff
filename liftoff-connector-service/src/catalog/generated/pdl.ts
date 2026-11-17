// Registry functions + dispatch — People Data Labs (peopledatalabs.com), native
// REST executor over api.peopledatalabs.com/v5. Bypasses Composio.
//
// Function names deliberately match the composio overlay names already seeded
// in migration 453 (enrich_person, enrich_company, search_people,
// search_companies, identify_person, enrich_ip, enrich_job_title,
// autocomplete_fields) so no new classification migration is needed — they are
// all reads. Auth is PDL's `X-Api-Key` header. PDL is pay-per-MATCH: an enrich
// that finds a record consumes a credit (a no-match/400 does not), which is a
// balance concern (fail-closed), not a gating one.

import type { ConnectorFunction } from '../../types.js';

/** functionName -> REST method + path. GET passes inputs as query params, POST
 *  as the JSON body; the X-Api-Key header carries auth either way. */
export const PDL_DISPATCH: Record<string, { method: 'GET' | 'POST'; path: string }> = {
  enrich_person: { method: 'GET', path: '/v5/person/enrich' },
  identify_person: { method: 'POST', path: '/v5/person/identify' },
  search_people: { method: 'POST', path: '/v5/person/search' },
  enrich_company: { method: 'GET', path: '/v5/company/enrich' },
  search_companies: { method: 'POST', path: '/v5/company/search' },
  enrich_ip: { method: 'GET', path: '/v5/ip/enrich' },
  enrich_job_title: { method: 'GET', path: '/v5/job_title/enrich' },
  autocomplete_fields: { method: 'GET', path: '/v5/autocomplete' },
};

export const PDL_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'enrich_person',
    description: 'Enrich a person from one or more identifiers (email, phone, name+company, LinkedIn profile)',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number (E.164)' },
        profile: { type: 'string', description: 'A social/LinkedIn profile URL' },
        name: { type: 'string', description: 'Full name (needs a company or location to disambiguate)' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        company: { type: 'string', description: 'Current company name or domain' },
        location: { type: 'string', description: 'Location to disambiguate a name' },
        min_likelihood: { type: 'number', description: 'Minimum match likelihood 1-10 (optional)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'identify_person',
    description: 'Return the most likely candidate records for a partial person identity',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        phone: { type: 'string' },
        name: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        company: { type: 'string' },
        location: { type: 'string' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'search_people',
    description: 'Search the person dataset with an Elasticsearch or SQL query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'object', description: 'An Elasticsearch query object' },
        sql: { type: 'string', description: 'A SQL query (alternative to query)' },
        size: { type: 'number', description: 'Max results, 1-100 (default 10)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'enrich_company',
    description: 'Enrich a company by website, name, ticker, or profile',
    inputSchema: {
      type: 'object',
      properties: {
        website: { type: 'string', description: 'Company website/domain' },
        name: { type: 'string', description: 'Company name' },
        profile: { type: 'string', description: 'A company social/LinkedIn URL' },
        ticker: { type: 'string', description: 'Stock ticker' },
        location: { type: 'string' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'search_companies',
    description: 'Search the company dataset with an Elasticsearch or SQL query',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'object', description: 'An Elasticsearch query object' },
        sql: { type: 'string', description: 'A SQL query (alternative to query)' },
        size: { type: 'number', description: 'Max results, 1-100 (default 10)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'enrich_ip',
    description: 'Enrich an IP address to its likely company and location',
    inputSchema: {
      type: 'object',
      properties: { ip: { type: 'string', description: 'The IP address' } },
      required: ['ip'],
    },
    categories: ['read'],
  },
  {
    name: 'enrich_job_title',
    description: 'Enrich a job title with its cleaned name, levels, and role/subrole',
    inputSchema: {
      type: 'object',
      properties: { job_title: { type: 'string', description: 'The job title text' } },
      required: ['job_title'],
    },
    categories: ['read'],
  },
  {
    name: 'autocomplete_fields',
    description: 'Autocomplete PDL field values (title, company, school, skill, location, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'The field to autocomplete, e.g. title, company, skill, location' },
        text: { type: 'string', description: 'The partial text' },
        size: { type: 'number', description: 'Max suggestions (optional)' },
      },
      required: ['field'],
    },
    categories: ['read'],
  },
];
