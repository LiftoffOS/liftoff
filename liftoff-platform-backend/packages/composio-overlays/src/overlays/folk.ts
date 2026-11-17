// folk overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const FOLK_OVERLAYS: Record<string, ComposioToolOverlay> = {
  FOLK_LIST_PEOPLE: { stableName: 'list_people', categoryOverrides: ["read"] },
  FOLK_GET_PERSON: { stableName: 'get_person', categoryOverrides: ["read"] },
  FOLK_FOLK_LIST_COMPANIES: { stableName: 'list_companies', categoryOverrides: ["read"] },
  FOLK_GET_COMPANY: { stableName: 'get_company', categoryOverrides: ["read"] },
  FOLK_CREATE_COMPANY: { stableName: 'create_company', categoryOverrides: ["write"] },
  FOLK_UPDATE_COMPANY: { stableName: 'update_company', categoryOverrides: ["write"] },
  FOLK_LIST_GROUPS: { stableName: 'list_groups', categoryOverrides: ["read"] },
  FOLK_LIST_USERS: { stableName: 'list_users', categoryOverrides: ["read"] },
  FOLK_GET_CURRENT_WORKSPACE_USER: { stableName: 'get_current_user', categoryOverrides: ["read"] },
};

export const FOLK_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
