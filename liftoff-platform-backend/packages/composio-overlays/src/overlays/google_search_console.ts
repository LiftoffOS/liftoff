// google_search_console overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.
//
// Provenance is stated in canonical shape, which for a passthrough overlay IS
// Composio's: `site_url` is the argument every site-scoped write takes, and the
// two site reads return `siteUrl` (a list under `siteEntry`, a single site at
// the top level) per the tools' output_parameters.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const GOOGLE_SEARCH_CONSOLE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GOOGLE_SEARCH_CONSOLE_LIST_SITES: {
    stableName: 'list_sites',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'site', path: 'siteEntry[].siteUrl' }],
  },
  GOOGLE_SEARCH_CONSOLE_GET_SITE: {
    stableName: 'get_site',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'site', path: 'siteUrl' }],
  },
  GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY: { stableName: 'query_search_analytics', categoryOverrides: ["read"] },
  GOOGLE_SEARCH_CONSOLE_INSPECT_URL: { stableName: 'inspect_url', categoryOverrides: ["read"] },
  GOOGLE_SEARCH_CONSOLE_LIST_SITEMAPS: { stableName: 'list_sitemaps', categoryOverrides: ["read"] },
  GOOGLE_SEARCH_CONSOLE_GET_SITEMAP: { stableName: 'get_sitemap', categoryOverrides: ["read"] },
  GOOGLE_SEARCH_CONSOLE_SUBMIT_SITEMAP: { stableName: 'submit_sitemap', categoryOverrides: ['write'], idArgs: ['site_url'] },
  GOOGLE_SEARCH_CONSOLE_ADD_SITE: { stableName: 'add_site', categoryOverrides: ['write'], idArgs: ['site_url'] },
  GOOGLE_SEARCH_CONSOLE_DELETE_SITE: { stableName: 'delete_site', categoryOverrides: ['write', 'destructive'], idArgs: ['site_url'] },
};

export const GOOGLE_SEARCH_CONSOLE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
