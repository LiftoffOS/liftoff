// zoho_desk overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ZOHO_DESK_OVERLAYS: Record<string, ComposioToolOverlay> = {
  ZOHO_DESK_LIST_TICKETS: { stableName: 'list_tickets', categoryOverrides: ["read"] },
  ZOHO_DESK_GET_TICKET: { stableName: 'get_ticket', categoryOverrides: ["read"] },
  ZOHO_DESK_SEARCH: { stableName: 'search', categoryOverrides: ["read"] },
  ZOHO_DESK_CREATE_TICKET: { stableName: 'create_ticket', categoryOverrides: ["write"] },
  ZOHO_DESK_UPDATE_TICKET: { stableName: 'update_ticket', categoryOverrides: ["write"] },
  ZOHO_DESK_GET_TICKET_THREAD: { stableName: 'get_ticket_thread', categoryOverrides: ["read"] },
  ZOHO_DESK_GET_TICKET_LATEST_THREAD: { stableName: 'get_ticket_latest_thread', categoryOverrides: ["read"] },
  ZOHO_DESK_LIST_TICKET_CONVERSATIONS: { stableName: 'list_ticket_conversations', categoryOverrides: ["read"] },
  ZOHO_DESK_GET_TICKET_RESOLUTION: { stableName: 'get_ticket_resolution', categoryOverrides: ["read"] },
  ZOHO_DESK_UPLOAD_TICKET_ATTACHMENT: { stableName: 'upload_ticket_attachment', categoryOverrides: ["write"] },
  ZOHO_DESK_DOWNLOAD_TICKET_ATTACHMENT: { stableName: 'download_ticket_attachment', categoryOverrides: ["read"] },
  ZOHO_DESK_LIST_CONTACTS: { stableName: 'list_contacts', categoryOverrides: ["read"] },
  ZOHO_DESK_GET_CONTACT: { stableName: 'get_contact', categoryOverrides: ["read"] },
  ZOHO_DESK_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  ZOHO_DESK_LIST_CONTACT_ACCOUNTS: { stableName: 'list_contact_accounts', categoryOverrides: ["read"] },
  ZOHO_DESK_UPDATE_ACCOUNT: { stableName: 'update_account', categoryOverrides: ["write"] },
  ZOHO_DESK_LIST_AGENTS: { stableName: 'list_agents', categoryOverrides: ["read"] },
  ZOHO_DESK_GET_AGENT: { stableName: 'get_agent', categoryOverrides: ["read"] },
  ZOHO_DESK_LIST_DEPARTMENTS: { stableName: 'list_departments', categoryOverrides: ["read"] },
  ZOHO_DESK_GET_DEPARTMENT: { stableName: 'get_department', categoryOverrides: ["read"] },
  ZOHO_DESK_LIST_ORGANIZATIONS: { stableName: 'list_organizations', categoryOverrides: ["read"] },
  ZOHO_DESK_LIST_VIEWS: { stableName: 'list_views', categoryOverrides: ["read"] },
};

export const ZOHO_DESK_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
