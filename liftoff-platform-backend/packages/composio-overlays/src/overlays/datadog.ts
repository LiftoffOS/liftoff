// datadog overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const DATADOG_OVERLAYS: Record<string, ComposioToolOverlay> = {
  DATADOG_LIST_MONITORS: { stableName: 'list_monitors', categoryOverrides: ["read"] },
  DATADOG_GET_MONITOR: { stableName: 'get_monitor', categoryOverrides: ["read"] },
  DATADOG_LIST_INCIDENTS: { stableName: 'list_incidents', categoryOverrides: ["read"] },
  DATADOG_LIST_EVENTS: { stableName: 'list_events', categoryOverrides: ["read"] },
  DATADOG_SEARCH_LOGS: { stableName: 'search_logs', categoryOverrides: ["read"] },
  DATADOG_QUERY_METRICS: { stableName: 'query_metrics', categoryOverrides: ["read"] },
  DATADOG_LIST_DASHBOARDS: { stableName: 'list_dashboards', categoryOverrides: ["read"] },
  DATADOG_GET_DASHBOARD: { stableName: 'get_dashboard', categoryOverrides: ["read"] },
  DATADOG_LIST_HOSTS: { stableName: 'list_hosts', categoryOverrides: ["read"] },
  DATADOG_LIST_SL_OS: { stableName: 'list_slos', categoryOverrides: ["read"] },
  DATADOG_LIST_APM_SERVICES: { stableName: 'list_apm_services', categoryOverrides: ["read"] },
  DATADOG_CREATE_MONITOR: { stableName: 'create_monitor', categoryOverrides: ["write"] },
  DATADOG_UPDATE_MONITOR: { stableName: 'update_monitor', categoryOverrides: ["write"] },
  DATADOG_MUTE_MONITOR: { stableName: 'mute_monitor', categoryOverrides: ["read"] },
  DATADOG_CREATE_EVENT: { stableName: 'create_event', categoryOverrides: ["write"] },
};

export const DATADOG_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
