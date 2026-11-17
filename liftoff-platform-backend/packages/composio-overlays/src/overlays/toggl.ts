// toggl overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const TOGGL_OVERLAYS: Record<string, ComposioToolOverlay> = {
  TOGGL_GET_PROJECTS: { stableName: 'list_projects', categoryOverrides: ["read"] },
  TOGGL_GET_PROJECT_DETAILS: { stableName: 'get_project', categoryOverrides: ["read"] },
  TOGGL_GET_LIST_CLIENTS: { stableName: 'list_clients', categoryOverrides: ["read"] },
  TOGGL_GET_CLIENT_DETAILS: { stableName: 'get_client', categoryOverrides: ["read"] },
  TOGGL_GET_CURRENT_TIME_ENTRY: { stableName: 'get_current_time_entry', categoryOverrides: ["read"] },
  TOGGL_GET_ORGANIZATION_USERS: { stableName: 'list_organization_users', categoryOverrides: ["read"] },
  TOGGL_CREATE_TIME_ENTRY: { stableName: 'create_time_entry', categoryOverrides: ["write"] },
  TOGGL_CREATE_PROJECT: { stableName: 'create_project', categoryOverrides: ["write"] },
  TOGGL_CREATE_CLIENT: { stableName: 'create_client', categoryOverrides: ["write"] },
};

export const TOGGL_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
