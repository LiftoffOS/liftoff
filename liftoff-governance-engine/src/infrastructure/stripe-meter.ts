// Stripe Meter Client — governance-engine.
//
// Phase 3e: the Stripe customer ID belongs to platform-backend. It is
// pushed to governance-engine via the `tenant.entitlement.updated` event on
// the control-plane-events topic (see events/entitlements-subscriber.ts)
// and materialised into the `cached_entitlements` table.
//
// On every meter emission we look up the customer ID from that local
// cache. A cache miss / expired row means we haven't received a fresh
// entitlement event for this tenant — we log a warning and SKIP the
// meter report rather than fabricating a customer ID, because Stripe
// billing is real money and reporting to the wrong account is worse than
// missing a data point (the next entitlement event hydrates the cache
// and subsequent meter calls succeed).
//
// `STRIPE_CUSTOMER_ID_OVERRIDE` remains as a last-resort fallback for
// local development only. In production this env var must be unset.

import Stripe from 'stripe';
import { pool } from './database';
import { logger } from './logging';

// Lazy Stripe client initialisation. The Stripe SDK throws at construction
// time when the API key is missing, which would crash startup on Cloud Run
// revisions that boot before STRIPE_SECRET_KEY is set (same class of bug as
// the smoke-test Stripe mock we added in test-utils/setup.ts). Deferring
// construction to first use lets the service start and health-check clean
// even when usage metering is not configured for this environment.
let stripeSingleton: Stripe | null = null;
function getStripe(): Stripe {
  if (stripeSingleton) return stripeSingleton;
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set — meter reporting requires a Stripe API key',
    );
  }
  stripeSingleton = new Stripe(apiKey);
  return stripeSingleton;
}

const customerIdCache = new Map<string, { customerId: string; cachedAt: number }>();
const CUSTOMER_CACHE_TTL_MS = 5 * 60 * 1000;

export interface MeterEventInput {
  tenantId: string;
  eventType: string;
  credits: number;
  timestamp: Date;
  idempotencyKey: string;
}

export class StripeMeterClient {
  async sendMeterEvent(input: MeterEventInput): Promise<void> {
    const customerId = await this.getCustomerId(input.tenantId);
    if (!customerId) {
      logger.warn(
        { tenant_id: input.tenantId, event_type: input.eventType },
        'stripe-meter: skipping event — no cached stripe customer id for tenant',
      );
      return;
    }

    await getStripe().billing.meterEvents.create(
      {
        event_name: input.eventType,
        payload: {
          stripe_customer_id: customerId,
          value: String(input.credits),
        },
        timestamp: Math.floor(input.timestamp.getTime() / 1000),
      },
      { idempotencyKey: input.idempotencyKey },
    );

    logger.info({
      message: 'Sent meter event to Stripe',
      tenant_id: input.tenantId,
      event_type: input.eventType,
      credits: input.credits,
    });
  }

  async getMeterSummary(
    tenantId: string,
    startTime: Date,
    endTime: Date,
  ): Promise<Record<string, number>> {
    const stripeCustomerId = await this.getCustomerId(tenantId);
    if (!stripeCustomerId) {
      logger.warn(
        { tenant_id: tenantId },
        'stripe-meter: getMeterSummary skipped — no cached stripe customer id',
      );
      return {};
    }
    const summaries: Record<string, number> = {};

    const meters = await getStripe().billing.meters.list({ limit: 100 });

    for (const meter of meters.data) {
      const summary = await getStripe().billing.meters.listEventSummaries(meter.id, {
        customer: stripeCustomerId,
        start_time: Math.floor(startTime.getTime() / 1000),
        end_time: Math.floor(endTime.getTime() / 1000),
      });

      let total = 0;
      for (const event of summary.data) {
        total += parseFloat(event.aggregated_value as unknown as string);
      }
      summaries[meter.event_name] = total;
    }

    return summaries;
  }

  // Public so callers + tests can resolve the customer id without going
  // through the full meter emission path.
  async getCustomerId(tenantId: string): Promise<string | null> {
    const cached = customerIdCache.get(tenantId);
    if (cached && Date.now() - cached.cachedAt < CUSTOMER_CACHE_TTL_MS) {
      return cached.customerId;
    }

    // Primary source — the cached_entitlements row populated by the
    // entitlements subscriber. Respect expires_at so we don't serve stale
    // data indefinitely after a long subscriber outage.
    try {
      const result = await pool.query(
        `SELECT entitlements_json, expires_at
           FROM cached_entitlements
          WHERE tenant_id = $1
          LIMIT 1`,
        [tenantId],
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        const now = new Date();
        const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
        if (expiresAt && expiresAt.getTime() < now.getTime()) {
          logger.warn(
            { tenant_id: tenantId, expires_at: expiresAt.toISOString() },
            'stripe-meter: cached_entitlements row expired — awaiting refresh',
          );
        } else {
          const json = (row.entitlements_json ?? {}) as Record<string, unknown>;
          const customerId =
            (json.customerId as string | undefined) ??
            (json.stripeCustomerId as string | undefined) ??
            null;
          if (customerId) {
            customerIdCache.set(tenantId, {
              customerId,
              cachedAt: Date.now(),
            });
            return customerId;
          }
        }
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, tenant_id: tenantId },
        'stripe-meter: cached_entitlements lookup failed',
      );
    }

    // Local-dev escape hatch only. In production this variable must be
    // unset so we never invent a customer id.
    const override = process.env.STRIPE_CUSTOMER_ID_OVERRIDE;
    if (override && process.env.NODE_ENV !== 'production') {
      logger.warn(
        { tenant_id: tenantId },
        'stripe-meter: using STRIPE_CUSTOMER_ID_OVERRIDE (dev-only fallback)',
      );
      customerIdCache.set(tenantId, {
        customerId: override,
        cachedAt: Date.now(),
      });
      return override;
    }

    return null;
  }

  clearCustomerCache(tenantId: string): void {
    customerIdCache.delete(tenantId);
  }
}
