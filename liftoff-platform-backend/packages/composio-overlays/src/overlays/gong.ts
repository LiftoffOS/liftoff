// gong overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const GONG_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GONG_RETRIEVE_CALL_DATA_BY_DATE_RANGE_V2_CALLS: { stableName: 'list_calls', categoryOverrides: ["read"] },
  GONG_RETRIEVE_DATA_FOR_A_SPECIFIC_CALL_V2_CALLS_ID: { stableName: 'get_call', categoryOverrides: ["read"] },
  GONG_RETRIEVE_FILTERED_CALL_DETAILS: { stableName: 'search_calls', categoryOverrides: ["read"] },
  GONG_RETRIEVE_TRANSCRIPTS_OF_CALLS_V2_CALLS_TRANSCRIPT: { stableName: 'get_call_transcripts', categoryOverrides: ["read"] },
  GONG_LIST_ALL_USERS_V2_USERS: { stableName: 'list_users', categoryOverrides: ["read"] },
  GONG_RETRIEVE_USER_V2_USERS_ID: { stableName: 'get_user', categoryOverrides: ["read"] },
  GONG_AGGREGATE_USER_ACTIVITY_STATISTICS: { stableName: 'get_user_activity', categoryOverrides: ["read"] },
};

export const GONG_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
