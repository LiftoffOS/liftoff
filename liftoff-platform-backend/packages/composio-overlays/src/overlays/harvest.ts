// harvest overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const HARVEST_OVERLAYS: Record<string, ComposioToolOverlay> = {
  HARVEST_LIST_PROJECTS: { stableName: 'list_projects', categoryOverrides: ["read"] },
  HARVEST_LIST_TIME_ENTRIES: { stableName: 'list_time_entries', categoryOverrides: ["read"] },
  HARVEST_LIST_CLIENTS: { stableName: 'list_clients', categoryOverrides: ["read"] },
  HARVEST_LIST_INVOICES: { stableName: 'list_invoices', categoryOverrides: ["read"] },
  HARVEST_LIST_TASKS: { stableName: 'list_tasks', categoryOverrides: ["read"] },
  HARVEST_LIST_USERS: { stableName: 'list_users', categoryOverrides: ["read"] },
  HARVEST_GET_COMPANY_INFO: { stableName: 'get_company_info', categoryOverrides: ["read"] },
  HARVEST_CREATE_TIME_ENTRY: { stableName: 'create_time_entry', categoryOverrides: ["write"] },
  HARVEST_CREATE_PROJECT: { stableName: 'create_project', categoryOverrides: ["write"] },
  HARVEST_CREATE_CLIENT: { stableName: 'create_client', categoryOverrides: ["write"] },
  HARVEST_CREATE_INVOICE: { stableName: 'create_invoice', categoryOverrides: ["write"] },
  HARVEST_CREATE_EXPENSE: { stableName: 'create_expense', categoryOverrides: ["write"] },
};

export const HARVEST_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
