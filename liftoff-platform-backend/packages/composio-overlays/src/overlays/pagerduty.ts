// pagerduty overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const PAGERDUTY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  PAGERDUTY_FETCH_INCIDENT_LIST: { stableName: 'list_incidents', categoryOverrides: ["read"] },
  PAGERDUTY_GET_ALERTS_BY_INCIDENT_ID: { stableName: 'list_incident_alerts', categoryOverrides: ["read"] },
  PAGERDUTY_GET_INCIDENT_ALERT_DETAILS: { stableName: 'get_alert_details', categoryOverrides: ["read"] },
  PAGERDUTY_RETRIEVE_LIST_OF_SERVICES: { stableName: 'list_services', categoryOverrides: ["read"] },
  PAGERDUTY_FETCH_ESCALATION_POLICES_LIST: { stableName: 'list_escalation_policies', categoryOverrides: ["read"] },
  PAGERDUTY_GET_ESCALATION_POLICY_BY_ID: { stableName: 'get_escalation_policy', categoryOverrides: ["read"] },
  PAGERDUTY_CREATE_INCIDENT_RECORD: { stableName: 'create_incident', categoryOverrides: ["write"] },
  PAGERDUTY_CREATE_ESCALATION_POLICY: { stableName: 'create_escalation_policy', categoryOverrides: ["write"] },
  PAGERDUTY_CREATE_NEW_SERVICE: { stableName: 'create_service', categoryOverrides: ["write"] },
  PAGERDUTY_MERGE_SOURCE_INCIDENTS_INTO_TARGET_INCIDENT: { stableName: 'merge_incidents', categoryOverrides: ["write"] },
};

export const PAGERDUTY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
