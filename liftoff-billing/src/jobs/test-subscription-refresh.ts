// Dev-only Cloud Scheduler job — defuses Stripe's test-mode retention policy.
//
// Stripe automatically cancels every subscription created in test mode 90
// days after creation ("Subscriptions created in a sandbox or in test mode
// are automatically canceled after 90 days" — and permanently deletes them 30
// days after that). That fires customer.subscription.deleted for a
// 90-day-old sub and suspends the workspace it belongs to. The
// Dashboard's "Exclude from auto-cancellation" action has no API equivalent
// (and caps at 50 subs), so exemption cannot be automated — instead this job
// re-provisions any subscription approaching the cutoff through
// replaceSubscriptionForTenant, the normal provisioning path, which refreshes
// billing_controls pointers and the local subscriptions mirror through the
// real webhook chain. Never a raw DB poke.
//
// Hard-gated to test mode: in live mode the retention policy does not exist
// and this job must never cancel a real customer's subscription.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Stripe from 'stripe';
import type { PlatformBackendClient } from '../infrastructure/platform-backend-client.js';
import { replaceSubscriptionForTenant } from '../routes/subscription-replace.js';
import type { ProvisionOpts } from '../routes/provision.js';

// Stripe cancels at 90 days; refresh 5 days early so a daily schedule has
// margin over scheduler downtime or job failures.
export const RETENTION_DAYS = 90;
export const REFRESH_AGE_DAYS = RETENTION_DAYS - 5;

const VALID_PLAN_IDS = new Set(['core', 'growth', 'scale', 'enterprise']);
const VALID_SOURCES = new Set(['self_serve', 'auto', 'admin_enterprise']);

// Rebuild the ProvisionOpts that originally created this subscription from
// the metadata provision.ts stamps on every sub it creates. Returns null
// (with a reason) when the metadata is insufficient — the caller logs every
// skip so nothing is silently dropped.
export function provisionOptsFromSubscription(
  sub: Stripe.Subscription,
): { opts: ProvisionOpts } | { skipReason: string } {
  const md = sub.metadata ?? {};
  const tenantId = md.tenant_id;
  if (!tenantId) return { skipReason: 'missing_metadata_tenant_id' };

  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  if (!customer) return { skipReason: 'missing_customer' };

  const planId =
    md.plan_id ?? md.plan_type ?? (md.billing_tier === 'enterprise' ? 'enterprise' : undefined);
  if (!planId || !VALID_PLAN_IDS.has(planId)) return { skipReason: `unresolvable_plan_id:${planId ?? 'none'}` };

  const source = VALID_SOURCES.has(md.provisioning_source) ? md.provisioning_source : 'auto';

  const priceItems: Stripe.SubscriptionCreateParams.Item[] = sub.items.data.map((item) => ({
    price: item.price.id,
    ...(item.quantity != null ? { quantity: item.quantity } : {}),
  }));
  if (priceItems.length === 0) return { skipReason: 'no_price_items' };

  const includedOus = Number.parseInt(md.included_ous ?? md.committed_ous ?? '0', 10) || 0;
  const precommitExtraOus = Number.parseInt(md.precommit_extra_ous ?? '0', 10) || 0;

  return {
    opts: {
      tenantId,
      stripeCustomerId: customer,
      planId: planId as ProvisionOpts['planId'],
      includedOus,
      precommitExtraOus,
      billingPeriod: md.billing_period === 'yearly' ? 'yearly' : 'monthly',
      provisioningSource: source as ProvisionOpts['provisioningSource'],
      priceItems,
    },
  };
}

export function registerTestSubscriptionRefreshRouter(
  app: FastifyInstance,
  deps: {
    stripe: Stripe;
    pbClient: PlatformBackendClient;
    billingServiceToken: string;
    /** true iff the Stripe key is sk_test_* — the ONLY mode this job may act in. */
    isTestMode: boolean;
  },
): void {
  app.post(
    '/api/internal/jobs/test-subscription-refresh',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = req.headers['x-service-auth'];
      if (!token || token !== deps.billingServiceToken) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      if (!deps.isTestMode) {
        // Live mode has no retention auto-cancel; refusing outright means a
        // misconfigured scheduler can never churn real subscriptions.
        app.log.warn('test-subscription-refresh: refused — live mode');
        return reply.code(200).send({ skipped: 'live_mode' });
      }

      // Collect every active subscription (paginated — no silent truncation).
      const active: Stripe.Subscription[] = [];
      for await (const sub of deps.stripe.subscriptions.list({ status: 'active', limit: 100 })) {
        active.push(sub);
      }

      // Group by tenant: replaceSubscriptionForTenant cancels ALL of a
      // tenant's active subs on the customer before re-provisioning, so one
      // call per tenant is both sufficient and required. A tenant is due
      // when its NEWEST active sub is past the refresh age — if a fresh sub
      // already exists, the aging one is a stale duplicate whose eventual
      // retention-cancel the suspension guards now handle.
      const cutoff = Math.floor(Date.now() / 1000) - REFRESH_AGE_DAYS * 24 * 3600;
      const newestByTenant = new Map<string, Stripe.Subscription>();
      let unattributed = 0;
      for (const sub of active) {
        const tenantId = sub.metadata?.tenant_id;
        if (!tenantId) {
          unattributed++;
          app.log.warn(
            { subscriptionId: sub.id, created: sub.created },
            'test-subscription-refresh: active sub has no metadata.tenant_id — cannot refresh',
          );
          continue;
        }
        const prev = newestByTenant.get(tenantId);
        if (!prev || sub.created > prev.created) newestByTenant.set(tenantId, sub);
      }

      let refreshed = 0;
      let skipped = 0;
      let failed = 0;
      for (const [tenantId, sub] of newestByTenant) {
        if (sub.created > cutoff) {
          skipped++;
          continue;
        }
        const rebuilt = provisionOptsFromSubscription(sub);
        if ('skipReason' in rebuilt) {
          skipped++;
          app.log.warn(
            { tenantId, subscriptionId: sub.id, reason: rebuilt.skipReason },
            'test-subscription-refresh: cannot rebuild provision opts — skipped',
          );
          continue;
        }
        try {
          const result = await replaceSubscriptionForTenant(rebuilt.opts, {
            stripe: deps.stripe,
            pbClient: deps.pbClient,
            log: {
              info: (m, o) => app.log.info({ ...o }, m),
              warn: (m, o) => app.log.warn({ ...o }, m),
            },
          });
          refreshed++;
          app.log.info(
            {
              tenantId,
              oldSubscriptionId: sub.id,
              newSubscriptionId: result.stripeSubscriptionId,
              ageDays: Math.floor((Date.now() / 1000 - sub.created) / 86400),
            },
            'test-subscription-refresh: subscription re-provisioned',
          );
        } catch (err) {
          failed++;
          app.log.error(
            { tenantId, subscriptionId: sub.id, error: (err as Error).message },
            'test-subscription-refresh: re-provision failed',
          );
        }
      }

      app.log.info(
        { activeSubs: active.length, tenants: newestByTenant.size, refreshed, skipped, failed, unattributed },
        'test-subscription-refresh: completed',
      );
      return reply.code(200).send({ activeSubs: active.length, refreshed, skipped, failed, unattributed });
    },
  );
}
