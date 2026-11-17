// plausible_analytics overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const PLAUSIBLE_ANALYTICS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  PLAUSIBLE_ANALYTICS_CHECK_HEALTH: { stableName: 'check_health', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_LIST_TEAMS: { stableName: 'list_teams', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_LIST_SITES: { stableName: 'list_sites', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_GET_SITE: { stableName: 'get_site', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_LIST_GOALS: { stableName: 'list_goals', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_LIST_CUSTOM_PROPS: { stableName: 'list_custom_properties', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_LIST_GUESTS: { stableName: 'list_guests', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_GET_REALTIME_VISITORS: { stableName: 'get_realtime_visitors', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_GET_TIMESERIES_STATS: { stableName: 'get_timeseries', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_GET_BREAKDOWN_STATS: { stableName: 'get_breakdown', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_QUERY_STATS: { stableName: 'query_stats', categoryOverrides: ["read"] },
  PLAUSIBLE_ANALYTICS_GET_PLUGIN_CAPABILITIES: { stableName: 'get_plugin_capabilities', categoryOverrides: ["read"] },
};

export const PLAUSIBLE_ANALYTICS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
