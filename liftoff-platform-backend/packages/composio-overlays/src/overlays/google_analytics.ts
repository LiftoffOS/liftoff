// google_analytics overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const GOOGLE_ANALYTICS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES: { stableName: 'list_account_summaries', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_LIST_ACCOUNTS_V1_BETA: { stableName: 'list_accounts', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_LIST_PROPERTIES_FILTERED: { stableName: 'list_properties', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_GET_PROPERTY: { stableName: 'get_property', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_LIST_DATA_STREAMS: { stableName: 'list_data_streams', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_GET_METADATA: { stableName: 'get_metadata', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_CHECK_COMPATIBILITY: { stableName: 'check_compatibility', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_RUN_REPORT: { stableName: 'run_report', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_BATCH_RUN_REPORTS: { stableName: 'batch_run_reports', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_RUN_PIVOT_REPORT: { stableName: 'run_pivot_report', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_RUN_REALTIME_REPORT: { stableName: 'run_realtime_report', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_RUN_FUNNEL_REPORT: { stableName: 'run_funnel_report', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_LIST_KEY_EVENTS: { stableName: 'list_key_events', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_LIST_CUSTOM_DIMENSIONS: { stableName: 'list_custom_dimensions', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_LIST_CUSTOM_METRICS: { stableName: 'list_custom_metrics', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_LIST_AUDIENCES: { stableName: 'list_audiences', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_LIST_CHANNEL_GROUPS: { stableName: 'list_channel_groups', categoryOverrides: ["read"] },
  GOOGLE_ANALYTICS_GET_ATTRIBUTION_SETTINGS: { stableName: 'get_attribution_settings', categoryOverrides: ["read"] },
};

export const GOOGLE_ANALYTICS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
