// Stripe Connector Normalizer
//
// Stripe is reactive via native polling (vendor-hosted MCP). The polling
// scheduler hands StripeMCPClient.list() results to normalize() as
// { results: [stripeObject, ...] }. Stripe list objects each carry an `object`
// discriminator ('payment_intent' | 'invoice' | 'subscription'), so this
// multi-entity normalizer routes each row by that field. Field sets are the
// documented Stripe API shapes, restricted to what a reactive subscription
// would predicate on (amount, currency, status, customer) plus identity + time.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface StripeObject {
  id?: string;
  object?: string;
  created?: number;
  currency?: string;
  status?: string;
  customer?: string;
  [k: string]: unknown;
}

const PaymentIntentSchema = z.object({
  id: z.string().describe('Stripe PaymentIntent id.'),
  status: z.string().optional().describe('PaymentIntent status (succeeded, processing, requires_payment_method, canceled).'),
  amount: z.number().optional().describe('Amount intended to be collected, in the currency minor unit.'),
  amountReceived: z.number().optional(),
  currency: z.string().optional(),
  customer: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string().optional().describe('Creation ISO timestamp.'),
});

const InvoiceSchema = z.object({
  id: z.string().describe('Stripe Invoice id.'),
  number: z.string().optional(),
  status: z.string().optional().describe('Invoice status (draft, open, paid, uncollectible, void).'),
  amountDue: z.number().optional(),
  amountPaid: z.number().optional(),
  currency: z.string().optional(),
  customer: z.string().optional(),
  dueDate: z.string().optional(),
  createdAt: z.string().optional(),
});

const SubscriptionSchema = z.object({
  id: z.string().describe('Stripe Subscription id.'),
  status: z.string().optional().describe('Subscription status (active, past_due, canceled, trialing, unpaid).'),
  currency: z.string().optional(),
  customer: z.string().optional(),
  currentPeriodEnd: z.string().optional().describe('Current billing period end ISO timestamp — anchor for renewal/expiry alerts.'),
  currentPeriodStart: z.string().optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
  createdAt: z.string().optional(),
});

function isoFromUnix(sec: unknown): string | undefined {
  return typeof sec === 'number' ? new Date(sec * 1000).toISOString() : undefined;
}

export class StripeNormalizer implements ConnectorNormalizer {
  connectorType = 'stripe';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    PaymentIntent: PaymentIntentSchema,
    Invoice: InvoiceSchema,
    Subscription: SubscriptionSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const rows = (payload as { results?: StripeObject[] })?.results ?? [];
    const records: NormalizedRecord[] = [];
    for (const row of rows) {
      const rec = this.normalizeRow(row);
      if (rec) records.push(rec);
    }
    return records;
  }

  private normalizeRow(o: StripeObject): NormalizedRecord | null {
    if (!o?.id) return null;
    const id = String(o.id);
    const base = { source: 'stripe', syncedAt: new Date(), version: hashCanonicalJson(o) };

    switch (o.object) {
      case 'payment_intent':
        return {
          entityType: 'PaymentIntent',
          externalId: id,
          data: {
            id, status: o.status, amount: o.amount as number | undefined,
            amountReceived: o.amount_received as number | undefined,
            currency: o.currency, customer: o.customer,
            description: o.description as string | undefined, createdAt: isoFromUnix(o.created),
          },
          metadata: base,
        };
      case 'invoice':
        return {
          entityType: 'Invoice',
          externalId: id,
          data: {
            id, number: o.number as string | undefined, status: o.status,
            amountDue: o.amount_due as number | undefined,
            amountPaid: o.amount_paid as number | undefined,
            currency: o.currency, customer: o.customer,
            dueDate: isoFromUnix(o.due_date), createdAt: isoFromUnix(o.created),
          },
          metadata: base,
        };
      case 'subscription':
        return {
          entityType: 'Subscription',
          externalId: id,
          data: {
            id, status: o.status, currency: o.currency, customer: o.customer,
            currentPeriodEnd: isoFromUnix(o.current_period_end),
            currentPeriodStart: isoFromUnix(o.current_period_start),
            cancelAtPeriodEnd: o.cancel_at_period_end as boolean | undefined,
            createdAt: isoFromUnix(o.created),
          },
          metadata: base,
        };
      default:
        return null;
    }
  }

  extractEntityType(record: unknown): string {
    const obj = (record as StripeObject)?.object;
    if (obj === 'payment_intent') return 'PaymentIntent';
    if (obj === 'invoice') return 'Invoice';
    if (obj === 'subscription') return 'Subscription';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    return String((record as StripeObject)?.id ?? '');
  }

  extractVersion(record: unknown): string | undefined {
    return hashCanonicalJson(record);
  }
}
