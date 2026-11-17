// WooCommerce Connector Normalizer
//
// WooCommerce is reactive via native polling (api_key sidecar connector; no
// Composio, no native webhook wired). The polling scheduler hands
// WooCommerceClient.list('Order') results to normalize() as { results: [order] }.
// Field set is the documented WooCommerce REST API v3 Order shape, restricted to
// the fields a reactive subscription would predicate on (status, total, currency,
// billing country/email) plus identity + timestamps.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface WooCommerceLineItem {
  id?: number;
  name?: string;
  product_id?: number;
  quantity?: number;
  total?: string;
}

interface WooCommerceBilling {
  email?: string;
  country?: string;
}

interface WooCommerceOrder {
  id?: number;
  number?: string;
  status?: string;
  currency?: string;
  total?: string;
  date_created?: string;
  date_created_gmt?: string;
  date_modified?: string;
  date_modified_gmt?: string;
  customer_id?: number;
  payment_method?: string;
  payment_method_title?: string;
  billing?: WooCommerceBilling;
  line_items?: WooCommerceLineItem[];
}

interface WooCommercePayload {
  results?: WooCommerceOrder[];
}

const OrderDataSchema = z.object({
  id: z.string().describe('WooCommerce order id.'),
  number: z.string().optional().describe('Human-facing order number.'),
  status: z.string().optional().describe('Order status (pending, processing, completed, cancelled, refunded, failed, on-hold).'),
  currency: z.string().optional().describe('ISO currency code of the order total.'),
  total: z.string().optional().describe('Grand total of the order as a decimal string.'),
  dateCreated: z.string().optional().describe('Order creation ISO timestamp (GMT).'),
  dateModified: z.string().optional().describe('Order last-modified ISO timestamp (GMT) — anchor for "alert N hours after an order" patterns.'),
  customerId: z.string().optional().describe('WooCommerce customer id, "0" for guest checkout.'),
  paymentMethod: z.string().optional().describe('Payment method slug.'),
  paymentMethodTitle: z.string().optional().describe('Human-readable payment method.'),
  billingEmail: z.string().optional().describe('Billing email of the purchaser.'),
  billingCountry: z.string().optional().describe('Billing country code, for country-mismatch fraud checks.'),
  itemCount: z.number().optional().describe('Number of line items on the order.'),
});

export class WooCommerceNormalizer implements ConnectorNormalizer {
  connectorType = 'woocommerce';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Order: OrderDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const orders = (payload as WooCommercePayload)?.results ?? [];
    const records: NormalizedRecord[] = [];

    for (const order of orders) {
      if (order?.id === undefined || order.id === null) continue;
      const id = String(order.id);
      const declared: Record<string, unknown> = {
        id,
        number: order.number,
        status: order.status,
        currency: order.currency,
        total: order.total,
        dateCreated: order.date_created_gmt ?? order.date_created,
        dateModified: order.date_modified_gmt ?? order.date_modified,
        customerId: order.customer_id !== undefined ? String(order.customer_id) : undefined,
        paymentMethod: order.payment_method,
        paymentMethodTitle: order.payment_method_title,
        billingEmail: order.billing?.email,
        billingCountry: order.billing?.country,
        itemCount: Array.isArray(order.line_items) ? order.line_items.length : undefined,
      };
      records.push({
        entityType: 'Order',
        externalId: id,
        data: declared,
        metadata: {
          source: 'woocommerce',
          syncedAt: new Date(),
          version: order.date_modified_gmt ?? order.date_modified ?? hashCanonicalJson(order),
        },
      });
    }

    return records;
  }

  extractEntityType(_record: unknown): string {
    return 'Order';
  }

  extractExternalId(record: unknown): string {
    return String((record as WooCommerceOrder).id ?? '');
  }

  extractVersion(record: unknown): string | undefined {
    const o = record as WooCommerceOrder;
    return o.date_modified_gmt ?? o.date_modified;
  }
}
