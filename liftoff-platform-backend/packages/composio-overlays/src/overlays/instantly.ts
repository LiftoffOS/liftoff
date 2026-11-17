// instantly overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const INSTANTLY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  INSTANTLY_LIST_CAMPAIGNS: { stableName: 'list_campaigns', categoryOverrides: ["read"] },
  INSTANTLY_GET_CAMPAIGN: { stableName: 'get_campaign', categoryOverrides: ["read"] },
  INSTANTLY_GET_CAMPAIGN_ANALYTICS: { stableName: 'get_campaign_analytics', categoryOverrides: ["read"] },
  INSTANTLY_LIST_LEADS: { stableName: 'list_leads', categoryOverrides: ["read"] },
  INSTANTLY_GET_LEAD: { stableName: 'get_lead', categoryOverrides: ["read"] },
  INSTANTLY_LIST_LEAD_LISTS: { stableName: 'list_lead_lists', categoryOverrides: ["read"] },
  INSTANTLY_LIST_ACCOUNTS: { stableName: 'list_email_accounts', categoryOverrides: ["read"] },
  INSTANTLY_CREATE_CAMPAIGN: { stableName: 'create_campaign', categoryOverrides: ["write"] },
  INSTANTLY_UPDATE_CAMPAIGN: { stableName: 'update_campaign', categoryOverrides: ["write"] },
  INSTANTLY_CREATE_LEAD: { stableName: 'create_lead', categoryOverrides: ["write"] },
  INSTANTLY_UPDATE_LEAD: { stableName: 'update_lead', categoryOverrides: ["write"] },
  INSTANTLY_CREATE_LEAD_LIST: { stableName: 'create_lead_list', categoryOverrides: ["write"] },
  INSTANTLY_UPDATE_LEAD_INTEREST_STATUS: { stableName: 'update_lead_status', categoryOverrides: ["write"] },
};

export const INSTANTLY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
