// zoho_inventory overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ZOHO_INVENTORY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  ZOHO_INVENTORY_LIST_ITEMS: { stableName: 'list_items', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_CREATE_ITEM: { stableName: 'create_item', categoryOverrides: ["write"] },
  ZOHO_INVENTORY_DELETE_ITEM: { stableName: 'delete_item', categoryOverrides: ["write","destructive"] },
  ZOHO_INVENTORY_LIST_ITEM_GROUPS: { stableName: 'list_item_groups', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_LIST_SALES_ORDERS: { stableName: 'list_sales_orders', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_GET_SALES_ORDER: { stableName: 'get_sales_order', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_CREATE_SALES_ORDER: { stableName: 'create_sales_order', categoryOverrides: ["write"] },
  ZOHO_INVENTORY_DELETE_SALES_ORDER: { stableName: 'delete_sales_order', categoryOverrides: ["write","destructive"] },
  ZOHO_INVENTORY_LIST_PURCHASE_ORDERS: { stableName: 'list_purchase_orders', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_CREATE_PURCHASE_ORDER: { stableName: 'create_purchase_order', categoryOverrides: ["write"] },
  ZOHO_INVENTORY_CREATE_PACKAGE: { stableName: 'create_package', categoryOverrides: ["write"] },
  ZOHO_INVENTORY_DELETE_PACKAGE: { stableName: 'delete_package', categoryOverrides: ["write","destructive"] },
  ZOHO_INVENTORY_LIST_INVOICES: { stableName: 'list_invoices', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_CREATE_INVOICE: { stableName: 'create_invoice', categoryOverrides: ["write"] },
  ZOHO_INVENTORY_DELETE_INVOICE: { stableName: 'delete_invoice', categoryOverrides: ["write","destructive"] },
  ZOHO_INVENTORY_EMAIL_INVOICE: { stableName: 'email_invoice', categoryOverrides: ["write","outbound"] },
  ZOHO_INVENTORY_LIST_INVOICE_PAYMENTS: { stableName: 'list_invoice_payments', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_CREATE_CUSTOMER_PAYMENT: { stableName: 'create_customer_payment', categoryOverrides: ["write"] },
  ZOHO_INVENTORY_LIST_CONTACTS: { stableName: 'list_contacts', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_GET_CONTACT: { stableName: 'get_contact', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  ZOHO_INVENTORY_DELETE_CONTACT: { stableName: 'delete_contact', categoryOverrides: ["write","destructive"] },
  ZOHO_INVENTORY_LIST_BILLS: { stableName: 'list_bills', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_CREATE_BILL: { stableName: 'create_bill', categoryOverrides: ["write"] },
  ZOHO_INVENTORY_LIST_CREDIT_NOTES: { stableName: 'list_credit_notes', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_CREATE_CREDIT_NOTE: { stableName: 'create_credit_note', categoryOverrides: ["write"] },
  ZOHO_INVENTORY_LIST_ORGANIZATIONS: { stableName: 'list_organizations', categoryOverrides: ["read"] },
  ZOHO_INVENTORY_GET_CURRENT_USER: { stableName: 'get_current_user', categoryOverrides: ["read"] },
};

export const ZOHO_INVENTORY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
