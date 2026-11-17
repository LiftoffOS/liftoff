// zoho_invoice overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ZOHO_INVOICE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  ZOHO_INVOICE_LIST_INVOICES: { stableName: 'list_invoices', categoryOverrides: ["read"] },
  ZOHO_INVOICE_GET_INVOICE: { stableName: 'get_invoice', categoryOverrides: ["read"] },
  ZOHO_INVOICE_CREATE_INVOICE: { stableName: 'create_invoice', categoryOverrides: ["write"] },
  ZOHO_INVOICE_DELETE_INVOICE: { stableName: 'delete_invoice', categoryOverrides: ["write","destructive"] },
  ZOHO_INVOICE_EMAIL_INVOICE: { stableName: 'email_invoice', categoryOverrides: ["write","outbound"] },
  ZOHO_INVOICE_MARK_INVOICE_AS_SENT: { stableName: 'mark_invoice_as_sent', categoryOverrides: ["write"] },
  ZOHO_INVOICE_MARK_INVOICE_AS_VOID: { stableName: 'mark_invoice_as_void', categoryOverrides: ["write"] },
  ZOHO_INVOICE_LIST_INVOICE_PAYMENTS: { stableName: 'list_invoice_payments', categoryOverrides: ["read"] },
  ZOHO_INVOICE_LIST_PAYMENTS: { stableName: 'list_payments', categoryOverrides: ["read"] },
  ZOHO_INVOICE_CREATE_CUSTOMER_PAYMENT: { stableName: 'create_customer_payment', categoryOverrides: ["write"] },
  ZOHO_INVOICE_LIST_ESTIMATES: { stableName: 'list_estimates', categoryOverrides: ["read"] },
  ZOHO_INVOICE_CREATE_ESTIMATE: { stableName: 'create_estimate', categoryOverrides: ["write"] },
  ZOHO_INVOICE_EMAIL_ESTIMATE: { stableName: 'email_estimate', categoryOverrides: ["write","outbound"] },
  ZOHO_INVOICE_LIST_EXPENSES: { stableName: 'list_expenses', categoryOverrides: ["read"] },
  ZOHO_INVOICE_GET_EXPENSE: { stableName: 'get_expense', categoryOverrides: ["read"] },
  ZOHO_INVOICE_LIST_CONTACTS: { stableName: 'list_contacts', categoryOverrides: ["read"] },
  ZOHO_INVOICE_GET_CONTACT: { stableName: 'get_contact', categoryOverrides: ["read"] },
  ZOHO_INVOICE_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  ZOHO_INVOICE_UPDATE_CONTACT: { stableName: 'update_contact', categoryOverrides: ["write"] },
  ZOHO_INVOICE_DELETE_CONTACT: { stableName: 'delete_contact', categoryOverrides: ["write","destructive"] },
  ZOHO_INVOICE_LIST_ITEMS: { stableName: 'list_items', categoryOverrides: ["read"] },
  ZOHO_INVOICE_GET_ITEM: { stableName: 'get_item', categoryOverrides: ["read"] },
  ZOHO_INVOICE_CREATE_ITEM: { stableName: 'create_item', categoryOverrides: ["write"] },
  ZOHO_INVOICE_LIST_CREDIT_NOTES: { stableName: 'list_credit_notes', categoryOverrides: ["read"] },
  ZOHO_INVOICE_CREATE_CREDIT_NOTE: { stableName: 'create_credit_note', categoryOverrides: ["write"] },
  ZOHO_INVOICE_LIST_RECURRING_INVOICES: { stableName: 'list_recurring_invoices', categoryOverrides: ["read"] },
  ZOHO_INVOICE_LIST_ORGANIZATIONS: { stableName: 'list_organizations', categoryOverrides: ["read"] },
  ZOHO_INVOICE_LIST_USERS: { stableName: 'list_users', categoryOverrides: ["read"] },
};

export const ZOHO_INVOICE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
