// fibery overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const FIBERY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  FIBERY_GET_ENTITIES: { stableName: 'list_entities', categoryOverrides: ["read"] },
  FIBERY_GET_ENTITY: { stableName: 'get_entity', categoryOverrides: ["read"] },
  FIBERY_POST_CREATE_ENTITY: { stableName: 'create_entity', categoryOverrides: ["write"] },
  FIBERY_EXECUTE_GRAPH_QL_QUERY: { stableName: 'execute_graphql', categoryOverrides: ["write"] },
  FIBERY_GET_GRAPH_QL_SCHEMA: { stableName: 'get_graphql_schema', categoryOverrides: ["read"] },
  FIBERY_POST_FETCH_DATA: { stableName: 'fetch_data', categoryOverrides: ["read"] },
  FIBERY_GET_CUSTOM_APPS: { stableName: 'list_custom_apps', categoryOverrides: ["read"] },
  FIBERY_GET_APP_INFO: { stableName: 'get_app_info', categoryOverrides: ["read"] },
};

export const FIBERY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
