// pipedrive overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const PIPEDRIVE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  PIPEDRIVE_GET_ALL_DEALS: { stableName: 'list_deals', categoryOverrides: ["read"] },
  PIPEDRIVE_GET_ALL_LEADS: { stableName: 'list_leads', categoryOverrides: ["read"] },
  PIPEDRIVE_GET_ALL_ORGANIZATIONS: { stableName: 'list_organizations', categoryOverrides: ["read"] },
  PIPEDRIVE_GET_ALL_ACTIVITIES_BETA: { stableName: 'list_activities', categoryOverrides: ["read"] },
  PIPEDRIVE_GET_DEALS_IN_A_PIPELINE: { stableName: 'list_deals_in_pipeline', categoryOverrides: ["read"] },
  PIPEDRIVE_ADD_A_DEAL: { stableName: 'create_deal', categoryOverrides: ["write"] },
  PIPEDRIVE_ADD_A_LEAD: { stableName: 'create_lead', categoryOverrides: ["write"] },
  PIPEDRIVE_ADD_A_PERSON: { stableName: 'create_person', categoryOverrides: ["write"] },
  PIPEDRIVE_ADD_AN_ORGANIZATION: { stableName: 'create_organization', categoryOverrides: ["write"] },
  PIPEDRIVE_ADD_AN_ACTIVITY: { stableName: 'create_activity', categoryOverrides: ["write"] },
};

export const PIPEDRIVE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
