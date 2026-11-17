// lemon_squeezy overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const LEMON_SQUEEZY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  LEMON_SQUEEZY_LIST_ALL_ORDERS: { stableName: 'list_orders', categoryOverrides: ["read"] },
  LEMON_SQUEEZY_LIST_ALL_CUSTOMERS: { stableName: 'list_customers', categoryOverrides: ["read"] },
  LEMON_SQUEEZY_LIST_ALL_PRODUCTS: { stableName: 'list_products', categoryOverrides: ["read"] },
  LEMON_SQUEEZY_LIST_ALL_SUBSCRIPTIONS: { stableName: 'list_subscriptions', categoryOverrides: ["read"] },
  LEMON_SQUEEZY_LIST_ALL_STORES: { stableName: 'list_stores', categoryOverrides: ["read"] },
  LEMON_SQUEEZY_LIST_ALL_PRICES: { stableName: 'list_prices', categoryOverrides: ["read"] },
  LEMON_SQUEEZY_LIST_ALL_VARIANTS: { stableName: 'list_variants', categoryOverrides: ["read"] },
  LEMON_SQUEEZY_LIST_ALL_SUBSCRIPTION_INVOICES: { stableName: 'list_subscription_invoices', categoryOverrides: ["read"] },
  LEMON_SQUEEZY_LIST_ALL_DISCOUNTS: { stableName: 'list_discounts', categoryOverrides: ["read"] },
  LEMON_SQUEEZY_CREATE_CUSTOMER: { stableName: 'create_customer', categoryOverrides: ["write"] },
};

export const LEMON_SQUEEZY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
