// quickbooks overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const QUICKBOOKS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  QUICKBOOKS_QUERY_ACCOUNT: { stableName: 'query_account', categoryOverrides: ["read"] },
  QUICKBOOKS_READ_ACCOUNT: { stableName: 'get_account', categoryOverrides: ["read"] },
  QUICKBOOKS_READ_CUSTOMER: { stableName: 'get_customer', categoryOverrides: ["read"] },
  QUICKBOOKS_READ_VENDOR: { stableName: 'get_vendor', categoryOverrides: ["read"] },
  QUICKBOOKS_READ_EMPLOYEE: { stableName: 'get_employee', categoryOverrides: ["read"] },
  QUICKBOOKS_CUSTOMER_BALANCE_REPORT: { stableName: 'customer_balance_report', categoryOverrides: ["read"] },
  QUICKBOOKS_VENDOR_BALANCE_REPORT: { stableName: 'vendor_balance_report', categoryOverrides: ["read"] },
  QUICKBOOKS_CREATE_CUSTOMER: { stableName: 'create_customer', categoryOverrides: ["write"] },
  QUICKBOOKS_CREATE_VENDOR: { stableName: 'create_vendor', categoryOverrides: ["write"] },
  QUICKBOOKS_CREATE_ACCOUNT: { stableName: 'create_account', categoryOverrides: ["write"] },
};

export const QUICKBOOKS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
