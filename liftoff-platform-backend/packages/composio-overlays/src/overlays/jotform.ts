// jotform overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const JOTFORM_OVERLAYS: Record<string, ComposioToolOverlay> = {
  JOTFORM_GET_USER_FORMS: { stableName: 'list_forms', categoryOverrides: ["read"] },
  JOTFORM_GET_USER_DETAILS: { stableName: 'get_user', categoryOverrides: ["read"] },
  JOTFORM_GET_USER_FOLDERS: { stableName: 'list_folders', categoryOverrides: ["read"] },
  JOTFORM_GET_USER_HISTORY: { stableName: 'get_user_history', categoryOverrides: ["read"] },
};

export const JOTFORM_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
