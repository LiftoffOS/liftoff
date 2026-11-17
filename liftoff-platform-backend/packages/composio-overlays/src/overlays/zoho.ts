// zoho overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ZOHO_OVERLAYS: Record<string, ComposioToolOverlay> = {
  ZOHO_LIST_LEADS: { stableName: 'list_leads', categoryOverrides: ["read"] },
  ZOHO_SEARCH_LEADS: { stableName: 'search_leads', categoryOverrides: ["read"] },
  ZOHO_CREATE_LEAD: { stableName: 'create_lead', categoryOverrides: ["write"] },
  ZOHO_UPDATE_LEAD: { stableName: 'update_lead', categoryOverrides: ["write"] },
  ZOHO_CONVERT_ZOHO_LEAD: { stableName: 'convert_lead', categoryOverrides: ["write"] },
  ZOHO_LIST_CONTACTS: { stableName: 'list_contacts', categoryOverrides: ["read"] },
  ZOHO_SEARCH_CONTACTS: { stableName: 'search_contacts', categoryOverrides: ["read"] },
  ZOHO_GET_CONTACT: { stableName: 'get_contact', categoryOverrides: ["read"] },
  ZOHO_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  ZOHO_DELETE_CONTACT: { stableName: 'delete_contact', categoryOverrides: ["write","destructive"] },
  ZOHO_LIST_ACCOUNTS: { stableName: 'list_accounts', categoryOverrides: ["read"] },
  ZOHO_SEARCH_ACCOUNTS: { stableName: 'search_accounts', categoryOverrides: ["read"] },
  ZOHO_GET_ACCOUNT: { stableName: 'get_account', categoryOverrides: ["read"] },
  ZOHO_UPDATE_ACCOUNT: { stableName: 'update_account', categoryOverrides: ["write"] },
  ZOHO_LIST_DEALS: { stableName: 'list_deals', categoryOverrides: ["read"] },
  ZOHO_SEARCH_DEALS: { stableName: 'search_deals', categoryOverrides: ["read"] },
  ZOHO_CREATE_DEAL: { stableName: 'create_deal', categoryOverrides: ["write"] },
  ZOHO_UPDATE_DEAL: { stableName: 'update_deal', categoryOverrides: ["write"] },
  ZOHO_DELETE_DEAL: { stableName: 'delete_deal', categoryOverrides: ["write","destructive"] },
  ZOHO_LIST_TASKS: { stableName: 'list_tasks', categoryOverrides: ["read"] },
  ZOHO_GET_TASK: { stableName: 'get_task', categoryOverrides: ["read"] },
  ZOHO_LIST_EVENTS: { stableName: 'list_events', categoryOverrides: ["read"] },
  ZOHO_CREATE_EVENT: { stableName: 'create_event', categoryOverrides: ["write"] },
  ZOHO_UPDATE_EVENT: { stableName: 'update_event', categoryOverrides: ["write"] },
  ZOHO_LIST_NOTES: { stableName: 'list_notes', categoryOverrides: ["read"] },
  ZOHO_CREATE_NOTE: { stableName: 'create_note', categoryOverrides: ["write"] },
  ZOHO_LIST_CALLS: { stableName: 'list_calls', categoryOverrides: ["read"] },
  ZOHO_GET_ZOHO_RECORDS: { stableName: 'get_records', categoryOverrides: ["read"] },
  ZOHO_SEARCH_ZOHO_RECORDS: { stableName: 'search_records', categoryOverrides: ["read"] },
  ZOHO_CREATE_ZOHO_RECORD: { stableName: 'create_record', categoryOverrides: ["write"] },
  ZOHO_UPDATE_ZOHO_RECORD: { stableName: 'update_record', categoryOverrides: ["write"] },
  ZOHO_CREATE_ZOHO_TAG: { stableName: 'create_tag', categoryOverrides: ["write"] },
  ZOHO_LIST_MODULES: { stableName: 'list_modules', categoryOverrides: ["read"] },
};

export const ZOHO_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
