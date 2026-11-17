// mixpanel overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const MIXPANEL_OVERLAYS: Record<string, ComposioToolOverlay> = {
  MIXPANEL_GET_ALL_PROJECTS: { stableName: 'list_projects', categoryOverrides: ["read"] },
  MIXPANEL_LIST_COHORTS: { stableName: 'list_cohorts', categoryOverrides: ["read"] },
  MIXPANEL_LIST_FUNNELS: { stableName: 'list_funnels', categoryOverrides: ["read"] },
  MIXPANEL_QUERY_SEGMENTATION: { stableName: 'query_segmentation', categoryOverrides: ["read"] },
  MIXPANEL_QUERY_FUNNEL: { stableName: 'query_funnel', categoryOverrides: ["read"] },
  MIXPANEL_QUERY_INSIGHT: { stableName: 'query_insight', categoryOverrides: ["read"] },
  MIXPANEL_QUERY_RETENTION_REPORT: { stableName: 'query_retention', categoryOverrides: ["read"] },
  MIXPANEL_QUERY_PROFILES: { stableName: 'query_profiles', categoryOverrides: ["read"] },
  MIXPANEL_AGGREGATE_EVENTS: { stableName: 'aggregate_events', categoryOverrides: ["read"] },
  MIXPANEL_TOP_EVENTS: { stableName: 'top_events', categoryOverrides: ["read"] },
  MIXPANEL_JQL_QUERY: { stableName: 'jql_query', categoryOverrides: ["read"] },
};

export const MIXPANEL_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
