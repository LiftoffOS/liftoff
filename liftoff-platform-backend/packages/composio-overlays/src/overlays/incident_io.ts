// incident_io overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const INCIDENT_IO_OVERLAYS: Record<string, ComposioToolOverlay> = {
  INCIDENT_IO_LIST_INCIDENTS_V2: { stableName: 'list_incidents', categoryOverrides: ["read"] },
  INCIDENT_IO_GET_INCIDENT_V2: { stableName: 'get_incident', categoryOverrides: ["read"] },
  INCIDENT_IO_LIST_ALERTS_V2: { stableName: 'list_alerts', categoryOverrides: ["read"] },
  INCIDENT_IO_LIST_INCIDENT_ALERTS_V2: { stableName: 'list_incident_alerts', categoryOverrides: ["read"] },
  INCIDENT_IO_LIST_INCIDENT_UPDATES_V2: { stableName: 'list_incident_updates', categoryOverrides: ["read"] },
  INCIDENT_IO_LIST_SEVERITIES_V1: { stableName: 'list_severities', categoryOverrides: ["read"] },
  INCIDENT_IO_LIST_USERS_V2: { stableName: 'list_users', categoryOverrides: ["read"] },
  INCIDENT_IO_LIST_INCIDENT_TYPES_V1: { stableName: 'list_incident_types', categoryOverrides: ["read"] },
  INCIDENT_IO_CREATE_INCIDENTS_V2: { stableName: 'create_incident', categoryOverrides: ["write"] },
};

export const INCIDENT_IO_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
