// lemlist overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const LEMLIST_OVERLAYS: Record<string, ComposioToolOverlay> = {
  LEMLIST_GET_CAMPAIGN_BY_ID: { stableName: 'get_campaign', categoryOverrides: ["read"] },
  LEMLIST_GET_CAMPAIGN_SEQUENCES: { stableName: 'get_campaign_sequences', categoryOverrides: ["read"] },
  LEMLIST_GET_EXPORT_CAMPAIGN_LEADS: { stableName: 'export_campaign_leads', categoryOverrides: ["read"] },
  LEMLIST_GET_RETRIEVE_LEAD_BY_EMAIL: { stableName: 'get_lead_by_email', categoryOverrides: ["read"] },
  LEMLIST_GET_RETRIEVE_ACTIVITIES: { stableName: 'list_activities', categoryOverrides: ["read"] },
  LEMLIST_GET_TEAM_INFO: { stableName: 'get_team_info', categoryOverrides: ["read"] },
  LEMLIST_POST_CREATE_CAMPAIGN: { stableName: 'create_campaign', categoryOverrides: ["write"] },
  LEMLIST_PATCH_UPDATE_CAMPAIGN: { stableName: 'update_campaign', categoryOverrides: ["write"] },
  LEMLIST_POST_ADD_VARIABLES_TO_LEAD: { stableName: 'add_variables_to_lead', categoryOverrides: ["write"] },
  LEMLIST_POST_MARK_LEAD_AS_INTERESTED_IN_CAMPAIGN: { stableName: 'mark_lead_interested', categoryOverrides: ["write"] },
  LEMLIST_POST_PAUSE_CAMPAIGN: { stableName: 'pause_campaign', categoryOverrides: ["write"] },
};

export const LEMLIST_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
