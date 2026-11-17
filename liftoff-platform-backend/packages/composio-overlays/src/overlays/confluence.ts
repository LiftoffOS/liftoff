// confluence overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const CONFLUENCE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  CONFLUENCE_SEARCH_CONTENT: { stableName: 'search_content', categoryOverrides: ["read"] },
  CONFLUENCE_GET_PAGES: { stableName: 'list_pages', categoryOverrides: ["read"] },
  CONFLUENCE_GET_PAGE_BY_ID: { stableName: 'get_page', categoryOverrides: ["read"] },
  CONFLUENCE_GET_SPACES: { stableName: 'list_spaces', categoryOverrides: ["read"] },
  CONFLUENCE_SEARCH_USERS: { stableName: 'search_users', categoryOverrides: ["read"] },
  CONFLUENCE_CREATE_PAGE: { stableName: 'create_page', categoryOverrides: ["write"] },
  CONFLUENCE_UPDATE_PAGE: { stableName: 'update_page', categoryOverrides: ["write"] },
};

export const CONFLUENCE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
