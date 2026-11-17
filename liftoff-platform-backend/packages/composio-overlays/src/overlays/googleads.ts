// googleads overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const GOOGLEADS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GOOGLEADS_GET_CAMPAIGN_BY_ID: { stableName: 'get_campaign', categoryOverrides: ["read"] },
  GOOGLEADS_GET_CAMPAIGN_BY_NAME: { stableName: 'get_campaign_by_name', categoryOverrides: ["read"] },
  GOOGLEADS_GET_CUSTOMER_LISTS: { stableName: 'list_customer_lists', categoryOverrides: ["read"] },
  GOOGLEADS_CREATE_CUSTOMER_LIST: { stableName: 'create_customer_list', categoryOverrides: ["write"] },
  GOOGLEADS_GOOGLEADS_ADD_OR_REMOVE_TO_CUSTOMER_LIST: { stableName: 'update_customer_list', categoryOverrides: ["write"] },
};

export const GOOGLEADS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
