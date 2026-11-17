import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Stripe from 'stripe';
import type { Pool } from 'pg';
import { withBillingTenant } from '../infrastructure/database.js';
import { provisionForTenant, type ProvisionOpts, type ProvisionResult, type ProvisionDeps } from './provision.js';
import type { PlatformBackendClient } from '../infrastructure/platform-backend-client.js';
import { validateInboundBillingHmac } from '../infrastructure/platform-backend-client.js';

// Error thrown when the local subscriptions row hasn't reflected canceled
// status within the polling window. Surfaces as 504 to the caller so they
// can retry with backoff instead of getting back a stale stripeSubscriptionId
// (Layer 1 of provisionForTenant would happily return the existing sub).
export class SubscriptionCancelTimeoutError extends Error {
  constructor(public readonly tenantId: string, public readonly waitedMs: number) {
    super(`Local subscription row did not reflect canceled status within ${waitedMs}ms for tenant ${tenantId}`);
    this.name = 'SubscriptionCancelTimeoutError';
  }
}

// Shared helper: cancel any existing active sub on Stripe, wait for the local
// row to reflect canceled (so the one-active-per-tenant unique index does not
// reject the new INSERT), then provision the replacement. Used by both the
// internal HMAC endpoint and the public /replace-subscription proxy below.
export async function replaceSubscriptionForTenant(
  opts: ProvisionOpts,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  const existing = await deps.stripe.subscriptions.list({
    customer: opts.stripeCustomerId, status: 'active', limit: 100,
  });
  // Filter by metadata.tenant_id — same reason as provision.ts Layer 2:
  // one Stripe customer can host multiple tenants.
  const ours = existing.data.filter((s) => s.metadata?.tenant_id === opts.tenantId);
  for (const s of ours) {
    await deps.stripe.subscriptions.cancel(s.id, { invoice_now: false, prorate: false });
  }

  // Wait for local row to reflect canceled (poll up to 30s). If the webhook
  // never lands within the window, throw — proceeding would either return the
  // stale active sub (Layer 1 short-circuit) or trip the
  // subscriptions_one_active_per_tenant unique index when Layer 3 inserts.
  const POLL_TIMEOUT_MS = 30_000;
  const start = Date.now();
  let stillActive = true;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    stillActive = await withBillingTenant(opts.tenantId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM subscriptions
          WHERE tenant_id = $1 AND status NOT IN ('canceled','incomplete_expired')
          LIMIT 1`,
        [opts.tenantId],
      );
      return rows.length > 0;
    });
    if (!stillActive) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (stillActive) {
    deps.log.warn('subscription-replace.cancel_poll_timeout',
      { tenantId: opts.tenantId, waitedMs: Date.now() - start });
    throw new SubscriptionCancelTimeoutError(opts.tenantId, Date.now() - start);
  }

  return provisionForTenant(opts, deps);
}

export function registerSubscriptionReplaceRouter(
  app: FastifyInstance,
  deps: { stripe: Stripe; pool: Pool; billingServiceToken: string; pbClient: PlatformBackendClient },
): void {
  const hmacPre = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const method = req.method, path = req.url.split('?')[0];
    const body = JSON.stringify((req.body as object) ?? {});
    const headers = {
      timestamp: req.headers['x-billing-timestamp'] as string | undefined,
      signature: req.headers['x-billing-signature'] as string | undefined,
    };
    if (!validateInboundBillingHmac(method, path, body, headers, deps.billingServiceToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  app.post('/api/internal/subscription/replace', { preHandler: hmacPre }, async (req, reply) => {
    const body = req.body as ProvisionOpts;
    if (!body.tenantId || !body.stripeCustomerId || !body.planId) {
      return reply.code(400).send({ error: 'missing_required_fields' });
    }
    try {
      const result = await replaceSubscriptionForTenant(body, {
        stripe: deps.stripe, pbClient: deps.pbClient,
        log: { info: console.log, warn: console.warn },
      });
      return reply.code(200).send({ stripeSubscriptionId: result.stripeSubscriptionId });
    } catch (err) {
      if (err instanceof SubscriptionCancelTimeoutError) {
        return reply.code(504).send({
          error: 'subscription_cancel_poll_timeout',
          tenantId: err.tenantId,
          waitedMs: err.waitedMs,
        });
      }
      throw err;
    }
  });
}
