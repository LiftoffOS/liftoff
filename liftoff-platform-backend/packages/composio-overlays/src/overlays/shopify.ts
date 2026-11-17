// shopify overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const SHOPIFY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  SHOPIFY_GET_ORDER_LIST: { stableName: 'list_orders', categoryOverrides: ["read"] },
  SHOPIFY_GET_ORDERSBY_ID: { stableName: 'get_order', categoryOverrides: ["read"] },
  SHOPIFY_GET_PRODUCTS: { stableName: 'list_products', categoryOverrides: ["read"] },
  SHOPIFY_GET_PRODUCT: { stableName: 'get_product', categoryOverrides: ["read"] },
  SHOPIFY_CREATE_ORDER: { stableName: 'create_order', categoryOverrides: ["write"] },
  SHOPIFY_CREATE_PRODUCT: { stableName: 'create_product', categoryOverrides: ["write"] },
  SHOPIFY_CREATE_CUSTOMER: { stableName: 'create_customer', categoryOverrides: ["write"] },
};

export const SHOPIFY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
