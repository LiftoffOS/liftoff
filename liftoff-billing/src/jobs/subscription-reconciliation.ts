// Daily Cloud Scheduler job — Stripe↔local subscription reconciliation.
//
// Silent drift is dangerous: a live, renewing Stripe subscription that never
// has a row in the local subscriptions table, or a billing_controls pointer
// at a subscription Stripe has hard-deleted, surfaces nowhere. This job
// makes that class of drift loud: for every Stripe customer the local table
// knows, it diffs Stripe's view of the customer's subscriptions against the
// local rows and the billing_controls pointer, and logs each divergence at
// ERROR with a stable structured name so log-based alerting can fire.
//
// Detections (log names are the alerting contract — do not rename):
//   (a) billing.reconciliation.untracked_stripe_subscription
//       Active-ish sub in Stripe with no local row at all.
//   (b) billing.reconciliation.local_active_stripe_canceled
//       Local row still active-ish whose Stripe counterpart is canceled or
//       gone entirely.
//   (c) billing.reconciliation.bc_pointer_mismatch
//       billing_controls.stripe_subscription_id points at a subscription
//       that is not active-ish in Stripe for that customer.
//   (d) billing.reconciliation.local_active_missing_sub_id
//       Local active-ish row with a NULL stripe_subscription_id — it cannot
//       be diffed against Stripe at all, which is its own drift.
//
// Customer universe: the UNION of customers in the local subscriptions
// table and customers PB's billing_controls knows (listBillingCustomers) —
// a customer the account migrated away from may exist only on the PB side.
// A PB listing failure aborts the run loudly rather than silently shrinking
// coverage.
//
// Detection only — no auto-repair. Repairs are operator decisions; this
// job's contract is that drift can no longer be silent.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Stripe from 'stripe';
import type { Pool } from 'pg';
import type { PlatformBackendClient } from '../infrastructure/platform-backend-client.js';

// Status set counted as "a live billing relationship". Matches the
// suspension guard's filter in stripe-event-processor.ts.
const ACTIVE_ISH = new Set(['active', 'trialing', 'past_due', 'incomplete']);

export function registerSubscriptionReconciliationRouter(
  app: FastifyInstance,
  deps: {
    stripe: Stripe;
    pool: Pool;
    pbClient: PlatformBackendClient;
    billingServiceToken: string;
  },
): void {
  app.post(
    '/api/internal/jobs/subscription-reconciliation',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = req.headers['x-service-auth'];
      if (!token || token !== deps.billingServiceToken) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const localCustomers = await deps.pool.query<{ stripe_customer_id: string }>( // rls-fence: allow (cross-tenant reconciliation, bg job)
        `SELECT DISTINCT stripe_customer_id FROM subscriptions WHERE stripe_customer_id IS NOT NULL`,
      );

      // PB's billing_controls universe. A failure here must not silently
      // shrink the sweep to local-only coverage — fail the run so the
      // scheduler retries and the failure is visible.
      let pbCustomers: Array<{ accountId: string; stripeCustomerId: string; stripeSubscriptionId: string | null; suspended?: boolean }>;
      try {
        pbCustomers = await deps.pbClient.listBillingCustomers();
      } catch (err) {
        app.log.error(
          { error: (err as Error).message },
          'subscription-reconciliation: PB customer listing failed — aborting run',
        );
        return reply.code(502).send({ error: 'pb_customer_listing_failed' });
      }

      const customerIds = new Set<string>();
      for (const r of localCustomers.rows) customerIds.add(r.stripe_customer_id);
      for (const c of pbCustomers) customerIds.add(c.stripeCustomerId);
      // Pointer source per customer — from the listing already fetched, so
      // the pointer check needs no further PB round-trips and never probes
      // PB for local-only (superseded) customers, which would 404 as
      // billing.internal.orphan_customer_no_resolution at ERROR every day.
      const pbByCustomer = new Map(pbCustomers.map((c) => [c.stripeCustomerId, c]));

      let untracked = 0;
      let localActiveStripeCanceled = 0;
      let localActiveMissingSubId = 0;
      let pointerMismatch = 0;
      let customersChecked = 0;
      let customersFailed = 0;

      for (const customerId of customerIds) {
        try {
          // Stripe's full view of this customer (paginated — no truncation).
          const stripeSubs = new Map<string, Stripe.Subscription>();
          for await (const sub of deps.stripe.subscriptions.list({
            customer: customerId,
            status: 'all',
            limit: 100,
          })) {
            stripeSubs.set(sub.id, sub);
          }

          const local = await deps.pool.query<{ // rls-fence: allow (cross-tenant reconciliation, bg job)
            stripe_subscription_id: string | null;
            status: string;
            tenant_id: string;
          }>(
            `SELECT stripe_subscription_id, status, tenant_id
               FROM subscriptions WHERE stripe_customer_id = $1`,
            [customerId],
          );
          const localById = new Map(
            local.rows.filter((r) => r.stripe_subscription_id).map((r) => [r.stripe_subscription_id as string, r]),
          );

          // (d) Active-ish local rows with no Stripe sub id at all — they
          // are invisible to every other diff, which is itself drift.
          for (const row of local.rows) {
            if (row.stripe_subscription_id) continue;
            if (!ACTIVE_ISH.has(row.status)) continue;
            localActiveMissingSubId++;
            app.log.error(
              { stripeCustomerId: customerId, tenantId: row.tenant_id, localStatus: row.status },
              'billing.reconciliation.local_active_missing_sub_id',
            );
          }

          // (a) Stripe-active subs the local table has never seen.
          for (const [subId, sub] of stripeSubs) {
            if (!ACTIVE_ISH.has(sub.status)) continue;
            if (localById.has(subId)) continue;
            untracked++;
            app.log.error(
              {
                stripeCustomerId: customerId,
                subscriptionId: subId,
                stripeStatus: sub.status,
                tenantIdFromMetadata: sub.metadata?.tenant_id ?? null,
                createdAt: new Date(sub.created * 1000).toISOString(),
              },
              'billing.reconciliation.untracked_stripe_subscription',
            );
          }

          // (b) Local active-ish rows whose Stripe counterpart is gone/dead.
          for (const [subId, row] of localById) {
            if (!ACTIVE_ISH.has(row.status)) continue;
            const stripeSub = stripeSubs.get(subId);
            if (stripeSub && ACTIVE_ISH.has(stripeSub.status)) continue;
            localActiveStripeCanceled++;
            app.log.error(
              {
                stripeCustomerId: customerId,
                subscriptionId: subId,
                tenantId: row.tenant_id,
                localStatus: row.status,
                stripeStatus: stripeSub?.status ?? 'missing',
              },
              'billing.reconciliation.local_active_stripe_canceled',
            );
          }

          // (c) billing_controls pointer must reference an active-ish Stripe
          // sub. Customers absent from the PB listing (superseded/local-only)
          // have no pointer to check, and SUSPENDED accounts are skipped —
          // a churned account's pointer legitimately references its dead sub
          // and would otherwise re-alert daily forever.
          const pbEntry = pbByCustomer.get(customerId);
          const pointer = pbEntry?.suspended ? null : pbEntry?.stripeSubscriptionId ?? null;
          if (pointer) {
            const pointed = stripeSubs.get(pointer);
            if (!pointed || !ACTIVE_ISH.has(pointed.status)) {
              pointerMismatch++;
              app.log.error(
                {
                  stripeCustomerId: customerId,
                  pointerSubscriptionId: pointer,
                  stripeStatus: pointed?.status ?? 'missing',
                  accountId: pbEntry?.accountId ?? null,
                },
                'billing.reconciliation.bc_pointer_mismatch',
              );
            }
          }

          customersChecked++;
        } catch (err) {
          customersFailed++;
          app.log.warn(
            { stripeCustomerId: customerId, error: (err as Error).message },
            'subscription-reconciliation: customer check failed — continuing',
          );
        }
      }

      const summary = {
        customers: customerIds.size,
        customersChecked,
        customersFailed,
        untracked,
        localActiveStripeCanceled,
        localActiveMissingSubId,
        pointerMismatch,
      };
      app.log.info(summary, 'subscription-reconciliation: completed');
      return reply.code(200).send(summary);
    },
  );
}
