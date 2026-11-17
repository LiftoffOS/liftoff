// typeform overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const TYPEFORM_OVERLAYS: Record<string, ComposioToolOverlay> = {
  TYPEFORM_LIST_FORMS: { stableName: 'list_forms', categoryOverrides: ["read"] },
  TYPEFORM_GET_FORM: { stableName: 'get_form', categoryOverrides: ["read"] },
  TYPEFORM_GET_FORM_RESPONSES: { stableName: 'get_form_responses', categoryOverrides: ["read"] },
  TYPEFORM_GET_FORM_MESSAGES: { stableName: 'get_form_messages', categoryOverrides: ["read"] },
  TYPEFORM_LIST_WORKSPACES: { stableName: 'list_workspaces', categoryOverrides: ["read"] },
  TYPEFORM_GET_ABOUT_ME: { stableName: 'get_current_user', categoryOverrides: ["read"] },
  TYPEFORM_CREATE_FORM: { stableName: 'create_form', categoryOverrides: ["write"] },
  TYPEFORM_CREATE_WORKSPACE: { stableName: 'create_workspace', categoryOverrides: ["write"] },
};

export const TYPEFORM_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
