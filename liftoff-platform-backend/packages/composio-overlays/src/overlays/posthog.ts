// posthog overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const POSTHOG_OVERLAYS: Record<string, ComposioToolOverlay> = {
  POSTHOG_LIST_PROJECTS_IN_ORGANIZATION_WITH_PAGINATION: { stableName: 'list_projects', categoryOverrides: ["read"] },
  POSTHOG_LIST_AND_FILTER_PROJECT_EVENTS: { stableName: 'list_events', categoryOverrides: ["read"] },
  POSTHOG_LIST_OR_DELETE_PERSONS_WITH_OPTIONAL_FILTERS: { stableName: 'list_persons', categoryOverrides: ["write","destructive"] },
  POSTHOG_LIST_AND_MANAGE_PROJECT_FEATURE_FLAGS: { stableName: 'list_feature_flags', categoryOverrides: ["write"] },
  POSTHOG_LIST_PROJECT_DASHBOARDS_WITH_PAGINATION: { stableName: 'list_dashboards', categoryOverrides: ["read"] },
  POSTHOG_LIST_PAGINATED_SURVEYS_FOR_A_PROJECT: { stableName: 'list_surveys', categoryOverrides: ["read"] },
  POSTHOG_LIST_PROJECT_ACTIONS_WITH_PAGINATION_AND_FILTERS: { stableName: 'list_actions', categoryOverrides: ["read"] },
  POSTHOG_RETRIEVE_EVENT_DEFINITIONS_BY_PROJECT_ID: { stableName: 'list_event_definitions', categoryOverrides: ["read"] },
  POSTHOG_LIST_AND_MANAGE_PROJECT_ANNOTATIONS: { stableName: 'list_annotations', categoryOverrides: ["write","destructive"] },
  POSTHOG_RETRIEVE_ASYNC_QUERY_STATUS_BY_ID: { stableName: 'get_query_status', categoryOverrides: ["read"] },
};

export const POSTHOG_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
