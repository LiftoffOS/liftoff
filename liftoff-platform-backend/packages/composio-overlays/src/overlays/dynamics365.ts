// dynamics365 overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const DYNAMICS365_OVERLAYS: Record<string, ComposioToolOverlay> = {
  DYNAMICS365_DYNAMICSCRM_GET_ALL_LEADS: { stableName: 'list_leads', categoryOverrides: ["read"] },
  DYNAMICS365_DYNAMICSCRM_GET_A_LEAD: { stableName: 'get_lead', categoryOverrides: ["read"] },
  DYNAMICS365_DYNAMICS365_GET_ALL_INVOICES_ACTION: { stableName: 'list_invoices', categoryOverrides: ["read"] },
  DYNAMICS365_DYNAMICSCRM_GET_A_INVOICE: { stableName: 'get_invoice', categoryOverrides: ["read"] },
  DYNAMICS365_DYNAMICSCRM_CREATE_LEAD: { stableName: 'create_lead', categoryOverrides: ["write"] },
  DYNAMICS365_DYNAMICSCRM_UPDATE_LEAD: { stableName: 'update_lead', categoryOverrides: ["write"] },
  DYNAMICS365_DYNAMICSCRM_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  DYNAMICS365_DYNAMICSCRM_CREATE_ACCOUNT: { stableName: 'create_account', categoryOverrides: ["write"] },
  DYNAMICS365_DYNAMICSCRM_CREATE_OPPORTUNITY: { stableName: 'create_opportunity', categoryOverrides: ["write"] },
  DYNAMICS365_DYNAMICSCRM_UPDATE_OPPORTUNITY: { stableName: 'update_opportunity', categoryOverrides: ["write"] },
  DYNAMICS365_DYNAMICSCRM_CREATE_CASE: { stableName: 'create_case', categoryOverrides: ["write"] },
  DYNAMICS365_DYNAMICSCRM_UPDATE_CASE: { stableName: 'update_case', categoryOverrides: ["write"] },
};

export const DYNAMICS365_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
