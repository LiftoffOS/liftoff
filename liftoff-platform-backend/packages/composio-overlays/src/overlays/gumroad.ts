// gumroad overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const GUMROAD_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GUMROAD_GET_SALES: { stableName: 'list_sales', categoryOverrides: ["read"] },
  GUMROAD_GET_USER: { stableName: 'get_user', categoryOverrides: ["read"] },
  GUMROAD_GET_RESOURCE_SUBSCRIPTIONS: { stableName: 'list_subscriptions', categoryOverrides: ["read"] },
  GUMROAD_SUBSCRIBE_TO_RESOURCE: { stableName: 'subscribe', categoryOverrides: ["write"] },
  GUMROAD_UNSUBSCRIBE_FROM_RESOURCE: { stableName: 'unsubscribe', categoryOverrides: ["write"] },
};

export const GUMROAD_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
