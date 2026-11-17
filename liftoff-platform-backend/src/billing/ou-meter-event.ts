// Stripe meter event firing for the `operating_unit_consumed` meter.
//
// Three internal paths fire this meter today:
//   1. spend-subscriber.ts — LLM real-time path (per invocation.completed)
//   2. billing-controls-internal-router.ts — backfill at billing init
//   3. cost-attribution/repository.ts ingestEventWithBuckets — every
//      non-LLM customer-chargeable cost source (Composio, future
//      governance, embeddings, web tools, etc.)
//
// All three must use identical event_name + payload shape so Stripe
// sums them into one usage line on the invoice. Centralising here also
// prevents drift in the dedup-key convention: `identifier` is the
// natural per-event ID (invocation_id for LLM, source_id for ingest
// rows), and Stripe enforces idempotency on it so duplicate fires are
// silently merged.
//
// Fire-and-forget: callers `void` the promise and the helper logs (but
// does not re-throw) on failure. Stripe meter retries are unnecessary
// because the next batch ingester pass would re-fire with the same
// identifier; missing one is recoverable, double-charging is not.

import { createHash } from 'crypto';
import { armOuMeterRetry } from '../jobs/maintenance-targets';
import Stripe from 'stripe';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { getStripeSecretKey } from '../infrastructure/secrets';

export const OU_METER_EVENT_NAME = 'operating_unit_consumed';

// Stripe rejects meter-event identifiers longer than 100 characters
// ("Invalid string ... must be at most 100 characters" — tenant-prefixed
// composite source ids can exceed it).
// Over-long identifiers are replaced with a deterministic sha256 digest:
// the same source event always maps to the same identifier, so Stripe's
// per-identifier idempotency survives retries and re-fires. Identifiers
// already within the limit pass through untouched, so historical dedup keys
// are unaffected (over-long ones never succeeded, so no continuity to lose).
const STRIPE_IDENTIFIER_MAX_CHARS = 100;
export function toStripeIdentifier(identifier: string): string {
  if (identifier.length <= STRIPE_IDENTIFIER_MAX_CHARS) return identifier;
  return `ou-sha256-${createHash('sha256').update(identifier).digest('hex')}`;
}

let _stripe: Stripe | null = null;
async function getStripe(): Promise<Stripe> {
  if (!_stripe) _stripe = new Stripe(await getStripeSecretKey());
  return _stripe;
}

export interface OuMeterEventArgs {
  /** Stripe customer_id from billing_controls.stripe_customer_id. */
  stripeCustomerId: string;
  /** Customer-chargeable USD cost (i.e. cost_usd that drained OUs). */
  costUsd: number;
  /** Per-event dedup key. Stripe collapses retries with the same value. */
  identifier: string;
  /** Event timestamp (UTC); Stripe expects unix seconds. */
  occurredAt: Date;
}

/**
 * Fires one `operating_unit_consumed` meter event. Awaitable, but
 * callers usually `void` it and rely on Stripe's idempotency for
 * retries (see header).
 *
 * Returns false on Stripe-side failure so callers can decide whether
 * to surface the error (most use cases shouldn't — meter failures must
 * not abort a billing-side write that already committed).
 */
export async function fireOuMeterEvent(args: OuMeterEventArgs): Promise<boolean> {
  try {
    const stripe = await getStripe();
    await stripe.billing.meterEvents.create({
      event_name: OU_METER_EVENT_NAME,
      payload: {
        // Stripe rejects values with more than 12 decimal places, and raw
        // float arithmetic upstream produces artifacts like
        // 0.16381859999999998. Serialize at fixed micro-dollar scale: 6 decimals
        // is far under Stripe's limit and beyond billing materiality.
        value: args.costUsd.toFixed(6),
        stripe_customer_id: args.stripeCustomerId,
      },
      identifier: toStripeIdentifier(args.identifier),
      timestamp: Math.floor(args.occurredAt.getTime() / 1000),
    });
    return true;
  } catch (err) {
    // ERROR, not warn: a rejected meter event is customer-billable usage
    // that never reaches the meter. Callers on paths with no natural re-fire
    // must use fireOuMeterEventDurable so the failure lands in the retry
    // table instead of being lost.
    log.error(
      {
        error: (err as Error).message,
        identifier: args.identifier,
        stripeCustomerId: args.stripeCustomerId,
        costUsd: args.costUsd,
      },
      'ou_meter_event_failed',
    );
    return false;
  }
}

/**
 * fireOuMeterEvent with durable failure capture: a failed fire is persisted
 * to ou_meter_event_retries (keyed by the ORIGINAL identifier, so the
 * hourly drain re-fires with identical idempotency semantics). Used by the
 * cost-attribution ingest path, which — unlike the LLM spend path with its
 * stripe_metered_at + init-backfill recovery — has no other re-fire
 * mechanism; without this, any Stripe-side failure there lost billable
 * usage permanently.
 *
 * The persistence itself failing is logged at ERROR and swallowed: meter
 * capture must never abort the caller's committed write path.
 */
export async function fireOuMeterEventDurable(args: OuMeterEventArgs): Promise<boolean> {
  const ok = await fireOuMeterEvent(args);
  if (ok) return true;
  try {
    await getPool().query(
      `INSERT INTO ou_meter_event_retries
         (identifier, stripe_customer_id, cost_usd, occurred_at, attempts, last_error)
       VALUES ($1, $2, $3, $4, 1, 'initial fire failed — see ou_meter_event_failed log')
       ON CONFLICT (identifier) DO UPDATE SET
         attempts   = ou_meter_event_retries.attempts + 1,
         updated_at = NOW()`,
      [args.identifier, args.stripeCustomerId, args.costUsd, args.occurredAt],
    );
    armOuMeterRetry();
  } catch (err) {
    log.error(
      { error: (err as Error).message, identifier: args.identifier },
      'ou_meter_event_retry_persist_failed',
    );
  }
  return false;
}
