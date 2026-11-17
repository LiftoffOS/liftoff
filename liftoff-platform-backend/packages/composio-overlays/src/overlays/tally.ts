// tally overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const TALLY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  TALLY_LIST_FORMS: { stableName: 'list_forms', categoryOverrides: ["read"] },
  TALLY_GET_FORM_DETAILS: { stableName: 'get_form', categoryOverrides: ["read"] },
  TALLY_GET_FORM_FIELDS: { stableName: 'get_form_fields', categoryOverrides: ["read"] },
  TALLY_GET_FORM_RESPONSES: { stableName: 'get_form_responses', categoryOverrides: ["read"] },
  TALLY_LIST_SUBMISSIONS: { stableName: 'list_submissions', categoryOverrides: ["read"] },
  TALLY_LIST_WORKSPACES: { stableName: 'list_workspaces', categoryOverrides: ["read"] },
  TALLY_CREATE_FORM: { stableName: 'create_form', categoryOverrides: ["write"] },
  TALLY_UPDATE_FORM: { stableName: 'update_form', categoryOverrides: ["write"] },
};

export const TALLY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
