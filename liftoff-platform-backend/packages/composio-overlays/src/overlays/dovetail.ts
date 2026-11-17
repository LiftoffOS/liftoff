// dovetail overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const DOVETAIL_OVERLAYS: Record<string, ComposioToolOverlay> = {
  DOVETAIL_LIST_PROJECTS: { stableName: 'list_projects', categoryOverrides: ["read"] },
  DOVETAIL_LIST_NOTES: { stableName: 'list_notes', categoryOverrides: ["read"] },
  DOVETAIL_GET_NOTE: { stableName: 'get_note', categoryOverrides: ["read"] },
  DOVETAIL_LIST_HIGHLIGHTS: { stableName: 'list_highlights', categoryOverrides: ["read"] },
  DOVETAIL_LIST_DATA: { stableName: 'list_data', categoryOverrides: ["read"] },
  DOVETAIL_LIST_CONTACTS: { stableName: 'list_contacts', categoryOverrides: ["read"] },
  DOVETAIL_LIST_USER_INSIGHTS: { stableName: 'list_insights', categoryOverrides: ["read"] },
  DOVETAIL_MAGIC_SEARCH: { stableName: 'search', categoryOverrides: ["read"] },
  DOVETAIL_CREATE_INSIGHT: { stableName: 'create_insight', categoryOverrides: ["write"] },
  DOVETAIL_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  DOVETAIL_CREATE_DATA_POINT: { stableName: 'create_data_point', categoryOverrides: ["write"] },
};

export const DOVETAIL_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
