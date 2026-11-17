// Stripe Meter Client
// Per Section 13: Stripe meters / meter events for usage billing
// Per Section 14: Stripe meter reconciliation

import Stripe from 'stripe';
import { logger } from './logging';
import { getEntitlementsClient } from '../entitlements-client/service';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

// Cache for Stripe customer IDs
const customerIdCache = new Map<string, { customerId: string; cachedAt: number }>();
const CUSTOMER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface MeterEventInput {
  tenantId: string;
  eventType: string;
  credits: number;
  /** Send this value to Stripe instead of credits, when set. Used to bill
   *  per-call vendor cost (in micro-USD or other unit) directly. */
  meterValueOverride?: number;
  timestamp: Date;
  idempotencyKey: string;
}

export class StripeMeterClient {
  // Per Section 13: Send meter event to Stripe
  // Meter events represent usage actions and are processed asynchronously on Stripe's side
  async sendMeterEvent(input: MeterEventInput): Promise<void> {
    const _meterId = this.getMeterId(input.eventType);

    // Per Section 13: Use Stripe meter events API
    const value = String(input.meterValueOverride ?? input.credits);
    await stripe.billing.meterEvents.create({
      event_name: input.eventType,
      payload: {
        stripe_customer_id: await this.getStripeCustomerId(input.tenantId),
        value,
      },
      timestamp: Math.floor(input.timestamp.getTime() / 1000),
    }, {
      idempotencyKey: input.idempotencyKey,
    });

    logger.info({
      message: 'Sent meter event to Stripe',
      tenant_id: input.tenantId,
      event_type: input.eventType,
      credits: input.credits,
    });
  }

  // Per Section 14: Fetch Stripe's processed meter totals for reconciliation
  async getMeterSummary(tenantId: string, startTime: Date, endTime: Date): Promise<Record<string, number>> {
    const stripeCustomerId = await this.getStripeCustomerId(tenantId);
    const summaries: Record<string, number> = {};

    // Fetch meter summaries from Stripe
    const meters = await stripe.billing.meters.list({ limit: 100 });

    for (const meter of meters.data) {
      const summary = await stripe.billing.meters.listEventSummaries(
        meter.id,
        {
          customer: stripeCustomerId,
          start_time: Math.floor(startTime.getTime() / 1000),
          end_time: Math.floor(endTime.getTime() / 1000),
        }
      );

      let total = 0;
      for (const event of summary.data) {
        total += parseFloat(event.aggregated_value as unknown as string);
      }
      summaries[meter.event_name] = total;
    }

    return summaries;
  }

  private getMeterId(eventType: string): string {
    // Map event types to Stripe meter IDs
    const meterMap: Record<string, string> = {
      'action_execution': process.env.STRIPE_METER_ID_ACTIONS || '',
      'workflow_execution': process.env.STRIPE_METER_ID_WORKFLOWS || '',
      'llm_tokens': process.env.STRIPE_METER_ID_TOKENS || '',
    };
    return meterMap[eventType] || '';
  }

  private async getStripeCustomerId(tenantId: string): Promise<string> {
    // Check local cache first
    const cached = customerIdCache.get(tenantId);
    if (cached && Date.now() - cached.cachedAt < CUSTOMER_CACHE_TTL_MS) {
      return cached.customerId;
    }

    // Fetch from entitlements client (which caches from control plane)
    const entitlementsClient = getEntitlementsClient();
    const entitlement = await entitlementsClient.getEntitlement(tenantId);

    // The entitlement should contain the Stripe customer ID
    // If it has a stripeCustomerId field, use it; otherwise construct from tenant ID
    const customerId = (entitlement as unknown as Record<string, unknown>).stripeCustomerId as string
      || `cus_${tenantId}`;

    // Cache the result
    customerIdCache.set(tenantId, {
      customerId,
      cachedAt: Date.now(),
    });

    logger.debug('Retrieved Stripe customer ID', { tenantId, customerId });

    return customerId;
  }

  // Clear cache for a specific tenant (useful when customer ID changes)
  clearCustomerCache(tenantId: string): void {
    customerIdCache.delete(tenantId);
  }
}
