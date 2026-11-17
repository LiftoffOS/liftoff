// mailerlite overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const MAILERLITE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  MAILERLITE_GET_SUBSCRIBERS: { stableName: 'list_subscribers', categoryOverrides: ["read"] },
  MAILERLITE_GET_CAMPAIGNS: { stableName: 'list_campaigns', categoryOverrides: ["read"] },
  MAILERLITE_GET_GROUPS: { stableName: 'list_groups', categoryOverrides: ["read"] },
  MAILERLITE_GET_GROUP_SUBSCRIBERS: { stableName: 'list_group_subscribers', categoryOverrides: ["read"] },
  MAILERLITE_GET_SEGMENTS: { stableName: 'list_segments', categoryOverrides: ["read"] },
  MAILERLITE_GET_FIELDS: { stableName: 'list_fields', categoryOverrides: ["read"] },
  MAILERLITE_GET_ACCOUNT_INFO: { stableName: 'get_account_info', categoryOverrides: ["read"] },
  MAILERLITE_CREATE_GROUP: { stableName: 'create_group', categoryOverrides: ["write"] },
  MAILERLITE_CREATE_SEGMENT: { stableName: 'create_segment', categoryOverrides: ["write"] },
  MAILERLITE_CREATE_FIELD: { stableName: 'create_field', categoryOverrides: ["write"] },
};

export const MAILERLITE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
