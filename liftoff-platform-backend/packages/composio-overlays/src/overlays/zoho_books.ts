// zoho_books overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ZOHO_BOOKS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  ZOHO_BOOKS_LIST_INVOICES: { stableName: 'list_invoices', categoryOverrides: ["read"] },
  ZOHO_BOOKS_GET_INVOICE: { stableName: 'get_invoice', categoryOverrides: ["read"] },
  ZOHO_BOOKS_UPDATE_INVOICE: { stableName: 'update_invoice', categoryOverrides: ["write"] },
  ZOHO_BOOKS_EMAIL_INVOICE: { stableName: 'email_invoice', categoryOverrides: ["write","outbound"] },
  ZOHO_BOOKS_LIST_BILLS: { stableName: 'list_bills', categoryOverrides: ["read"] },
  ZOHO_BOOKS_GET_BILL: { stableName: 'get_bill', categoryOverrides: ["read"] },
  ZOHO_BOOKS_UPDATE_BILL: { stableName: 'update_bill', categoryOverrides: ["write"] },
  ZOHO_BOOKS_LIST_ESTIMATES: { stableName: 'list_estimates', categoryOverrides: ["read"] },
  ZOHO_BOOKS_GET_ESTIMATE: { stableName: 'get_estimate', categoryOverrides: ["read"] },
  ZOHO_BOOKS_UPDATE_ESTIMATE: { stableName: 'update_estimate', categoryOverrides: ["write"] },
  ZOHO_BOOKS_EMAIL_ESTIMATE: { stableName: 'email_estimate', categoryOverrides: ["write","outbound"] },
  ZOHO_BOOKS_LIST_EXPENSES: { stableName: 'list_expenses', categoryOverrides: ["read"] },
  ZOHO_BOOKS_GET_EXPENSE: { stableName: 'get_expense', categoryOverrides: ["read"] },
  ZOHO_BOOKS_CREATE_EXPENSE: { stableName: 'create_expense', categoryOverrides: ["write"] },
  ZOHO_BOOKS_LIST_CUSTOMER_PAYMENTS: { stableName: 'list_customer_payments', categoryOverrides: ["read"] },
  ZOHO_BOOKS_LIST_CONTACTS: { stableName: 'list_contacts', categoryOverrides: ["read"] },
  ZOHO_BOOKS_GET_CONTACT: { stableName: 'get_contact', categoryOverrides: ["read"] },
  ZOHO_BOOKS_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  ZOHO_BOOKS_UPDATE_CONTACT: { stableName: 'update_contact', categoryOverrides: ["write"] },
  ZOHO_BOOKS_LIST_ITEMS: { stableName: 'list_items', categoryOverrides: ["read"] },
  ZOHO_BOOKS_GET_ITEM: { stableName: 'get_item', categoryOverrides: ["read"] },
  ZOHO_BOOKS_CREATE_ITEM: { stableName: 'create_item', categoryOverrides: ["write"] },
  ZOHO_BOOKS_UPDATE_ITEM: { stableName: 'update_item', categoryOverrides: ["write"] },
  ZOHO_BOOKS_LIST_SALES_ORDERS: { stableName: 'list_sales_orders', categoryOverrides: ["read"] },
  ZOHO_BOOKS_GET_SALES_ORDER: { stableName: 'get_sales_order', categoryOverrides: ["read"] },
  ZOHO_BOOKS_UPDATE_SALES_ORDER: { stableName: 'update_sales_order', categoryOverrides: ["write"] },
  ZOHO_BOOKS_LIST_PURCHASE_ORDERS: { stableName: 'list_purchase_orders', categoryOverrides: ["read"] },
  ZOHO_BOOKS_GET_PURCHASE_ORDER: { stableName: 'get_purchase_order', categoryOverrides: ["read"] },
  ZOHO_BOOKS_LIST_CREDIT_NOTES: { stableName: 'list_credit_notes', categoryOverrides: ["read"] },
  ZOHO_BOOKS_GET_CREDIT_NOTE: { stableName: 'get_credit_note', categoryOverrides: ["read"] },
  ZOHO_BOOKS_CREATE_JOURNAL: { stableName: 'create_journal', categoryOverrides: ["write"] },
  ZOHO_BOOKS_LIST_ORGANIZATIONS: { stableName: 'list_organizations', categoryOverrides: ["read"] },
  ZOHO_BOOKS_GET_ORGANIZATION: { stableName: 'get_organization', categoryOverrides: ["read"] },
  ZOHO_BOOKS_CREATE_INVOICE_FROM_SALESORDER: { stableName: 'create_invoice_from_sales_order', categoryOverrides: ["write"] },
  ZOHO_BOOKS_MARK_INVOICE_AS_SENT: { stableName: 'mark_invoice_as_sent', categoryOverrides: ["write"] },
  ZOHO_BOOKS_VOID_INVOICE: { stableName: 'void_invoice', categoryOverrides: ["write"] },
  ZOHO_BOOKS_DELETE_INVOICE: { stableName: 'delete_invoice', categoryOverrides: ["write","destructive"] },
  ZOHO_BOOKS_LIST_INVOICE_PAYMENTS: { stableName: 'list_invoice_payments', categoryOverrides: ["read"] },
};

export const ZOHO_BOOKS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
