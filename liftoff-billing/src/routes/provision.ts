import type Stripe from 'stripe';
import type { TenantScopedClient } from '@liftoffos/database';
import { enqueueOutboxEvent } from '@liftoffos/outbox';
import type { PlatformBackendClient } from '../infrastructure/platform-backend-client.js';
import { withBillingTenant } from '../infrastructure/database.js';
import { upsertSubscription, makeEnvelope } from '../consumers/stripe-event-processor.js';

export interface ProvisionOpts {
  tenantId: string;
  stripeCustomerId: string;
  planId: 'core' | 'growth' | 'scale' | 'enterprise';
  includedOus: number;
  precommitExtraOus: number;
  billingPeriod: 'monthly' | 'yearly';
  provisioningSource: 'self_serve' | 'auto' | 'admin_enterprise';
  priceItems: Stripe.SubscriptionCreateParams.Item[];  // caller constructs (ad-hoc or catalog)
  discounts?: Stripe.SubscriptionCreateParams['discounts'];
  invoiceSettings?: Stripe.SubscriptionCreateParams['invoice_settings'];
  extraMetadata?: Record<string, string>;
  paymentBehavior?: Stripe.SubscriptionCreateParams['payment_behavior'];
  // PR 4 / Gap C — opt-in cleanup pre-step. When true, before Layer 1 we:
  //   (1) Stripe-search for active/trialing subs tagged with this tenant_id
  //       on a DIFFERENT customer ("orphans"), cancel each.
  //   (2) Mark local subscriptions rows for this tenant as canceled.
  //   (3) Emit billing.provision.orphan_state_cleaned for audit trail.
  // Used only by the admin enterprise path; self-serve callers leave it
  // undefined → default false → today's behavior preserved.
  cleanOrphanState?: boolean;
}

export interface ProvisionResult {
  alreadyExists: boolean;
  stripeSubscriptionId: string;
}

export interface ProvisionDeps {
  stripe: Stripe;
  pbClient: PlatformBackendClient;
  log: { info: (m: string, o?: object) => void; warn: (m: string, o?: object) => void };
}

export async function provisionForTenant(opts: ProvisionOpts, deps: ProvisionDeps): Promise<ProvisionResult> {
  return withBillingTenant(opts.tenantId, async (client) => {
    // Serialize concurrent provisioners for this tenant across pods.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`tenant:${opts.tenantId}:subscription`]); // rls-fence: allow (advisory lock, not a data query)

    // PR 4 / Gap C — opt-in orphan-state cleanup. Runs INSIDE the advisory
    // lock (per Q18 trade-off): Stripe cancel calls are 1–3s each, so the
    // per-tenant lock is held for N×(1–3s) when N orphans are cancelled.
    // Acceptable because:
    //   - The cleanup path is admin-triggered, low-frequency.
    //   - The lock is per-tenant, not global — other tenants' provisioning
    //     is unaffected.
    //   - Orphan counts are expected to be small.
    // Revisit only if measured contention becomes a real problem.
    if (opts.cleanOrphanState === true) {
      await cleanOrphanStateForTenant(client, opts, deps);
    }

    // Layer 1: local guard.
    const local = await client.query<{ stripe_subscription_id: string }>(
      `SELECT stripe_subscription_id FROM subscriptions
        WHERE tenant_id = $1 AND status NOT IN ('canceled','incomplete_expired')
        LIMIT 1`,
      [opts.tenantId],
    );
    if (local.rows[0]) {
      // Auto-replace exception: when a self-serve provision finds an existing
      // subscription that was auto-provisioned by PB's TenantService.activate
      // (provisioning_source: 'auto'), cancel it and continue to create the
      // user's real subscription. Without this, /subscribe would forever
      // return 409 already_subscribed during /onboarding — the user's promo
      // code could never be redeemed and the chosen plan would never apply.
      // The webhook hook in stripe-event-processor.onSubscriptionCreated
      // performs a similar cancel-on-checkout, but only AFTER a successful
      // self-serve sub create, which never happens while alreadyExists
      // short-circuits Layer 1.
      //
      // Stripe.subscriptions.cancel is synchronous (the sub is canceled when
      // the call returns), so Layer 2's status='active' filter won't re-match
      // it. We also mark the local row canceled in the same tx so the
      // subsequent insert can't observe a stale "active" row via Layer 1 on
      // a re-entry.
      if (opts.provisioningSource === 'self_serve') {
        const existing = await deps.stripe.subscriptions.retrieve(local.rows[0].stripe_subscription_id);
        if (existing.metadata?.provisioning_source === 'auto') {
          await deps.stripe.subscriptions.cancel(existing.id, { invoice_now: false, prorate: false });
          await client.query( // rls-fence: allow (tenant provisioning, admin)
            `UPDATE subscriptions
               SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
             WHERE stripe_subscription_id = $1`,
            [existing.id],
          );
          deps.log.info('subscription.auto_replaced_on_subscribe',
            { tenantId: opts.tenantId, canceledSubId: existing.id });
          // Fall through to Layer 2/3 to create the real subscription.
        } else {
          return { alreadyExists: true, stripeSubscriptionId: local.rows[0].stripe_subscription_id };
        }
      } else {
        return { alreadyExists: true, stripeSubscriptionId: local.rows[0].stripe_subscription_id };
      }
    }

    // Layer 2: Stripe-side guard — covers webhook lag / local row never written.
    // Filter by metadata.tenant_id when matching, because one Stripe customer
    // can host multiple tenants (rare but possible — same billing contact across
    // workspaces). Without the filter we'd backfill the wrong sub onto the
    // wrong local tenant_id and short-circuit the create.
    const stripeActive = await deps.stripe.subscriptions.list({
      customer: opts.stripeCustomerId, status: 'active', limit: 100,
    });
    const matched = stripeActive.data.find(
      (s) => s.metadata?.tenant_id === opts.tenantId,
    );
    if (matched) {
      await upsertSubscription(client, opts.tenantId, matched, opts.planId);
      deps.log.warn('subscription.backfill_during_provision',
        { tenantId: opts.tenantId, subscriptionId: matched.id });
      return { alreadyExists: true, stripeSubscriptionId: matched.id };
    }

    // Layer 3: create + synchronous local write in same tx.
    const sub = await deps.stripe.subscriptions.create({
      customer: opts.stripeCustomerId,
      items: opts.priceItems,
      payment_behavior: opts.paymentBehavior ?? 'allow_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      discounts: opts.discounts,
      invoice_settings: opts.invoiceSettings,
      metadata: {
        tenant_id: opts.tenantId,
        // plan_id is the canonical local plans.id; plan_type carries the same
        // value but is the key the stripe-event-processor reads (it predates
        // plan_id). Set both so subscription.updated webhooks resolve the
        // self-serve plan_type from metadata without falling back to the
        // STRIPE_PLAN_*_PRICE_ID env-var lookup.
        plan_id: opts.planId,
        plan_type: opts.planId,
        included_ous: String(opts.includedOus),
        precommit_extra_ous: String(opts.precommitExtraOus),
        // committed_ous mirrors the slider value the user picked (base
        // included + precommit extra). Mirrored explicitly because some
        // downstream consumers key on it instead of including+precommit.
        committed_ous: String(opts.includedOus + opts.precommitExtraOus),
        billing_period: opts.billingPeriod,
        provisioning_source: opts.provisioningSource,
        ...(opts.extraMetadata ?? {}),
      },
    });
    await upsertSubscription(client, opts.tenantId, sub, opts.planId);
    return { alreadyExists: false, stripeSubscriptionId: sub.id };
  });
}

// PR 4 / Gap C — cleanup pre-step. NOT exported; only callable through
// provisionForTenant under the per-tenant advisory lock.
//
// Steps:
//   1. Stripe search for active/trialing subs tagged with this tenant_id.
//      Limit 100 per page; **paginate when has_more=true** so we handle the
//      rare overflow case. Emit `provision.clean_orphan.has_more_paginated`
//      whenever we go beyond the first page (= >100 orphans) so the unusual
//      condition is observable.
//   2. Cancel each match whose customer !== opts.stripeCustomerId. Subs on
//      the CANONICAL customer are left alone — Layer 1/2 handles those.
//   3. UPDATE subscriptions SET status='canceled' for any non-terminal local
//      rows on this tenant.
//   4. Emit billing.provision.orphan_state_cleaned outbox event so operators
//      have an audit trail of the destructive Stripe cancellations.
async function cleanOrphanStateForTenant(
  client: TenantScopedClient,
  opts: ProvisionOpts,
  deps: ProvisionDeps,
): Promise<void> {
  // 1. Stripe search with cursor-based pagination. We page through ALL
  // matching subs rather than truncating at 100 — the plan-literal
  // interpretation of "Page only if has_more === true". Each page can
  // contain up to 100 results; orphan counts are expected to be small so the
  // loop almost always exits after one iteration.
  // Stripe Search disallows mixing AND with OR in a single query
  // ("Queries cannot have a mix of AND and OR"). Fan out into one paginated
  // search per status and union the results, deduping by sub id.
  const allMatches: Stripe.Subscription[] = [];
  const seenIds = new Set<string>();
  let totalProcessed = 0;
  let didPaginate = false;
  // Safety bound — Stripe search has implicit limits, but cap the loop just
  // in case to prevent a runaway under unexpected response shapes.
  const MAX_PAGES = 20;
  for (const status of ['active', 'trialing'] as const) {
    let nextPage: string | undefined;
    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      const searchRes: Stripe.ApiSearchResult<Stripe.Subscription> = await deps.stripe.subscriptions.search({
        query: `metadata['tenant_id']:'${opts.tenantId}' AND status:'${status}'`,
        limit: 100,
        ...(nextPage !== undefined ? { page: nextPage } : {}),
      });
      for (const sub of searchRes.data) {
        if (seenIds.has(sub.id)) continue;
        seenIds.add(sub.id);
        allMatches.push(sub);
      }
      totalProcessed += searchRes.data.length;
      if (!searchRes.has_more || !searchRes.next_page) break;
      nextPage = searchRes.next_page;
      didPaginate = true;
    }
  }
  if (didPaginate) {
    // Log a warning beyond 100 (any status) — the rare-but-possible overflow.
    deps.log.warn('provision.clean_orphan.has_more_paginated', {
      tenantId: opts.tenantId,
      totalProcessed,
    });
  }

  // 2. Cancel only orphans (customer mismatch). Same-customer subs are
  // covered by the existing Layer 1/2 dedup; cancelling them here would be
  // wrong (could destroy a legitimate sub the operator is re-provisioning).
  const orphanIds: string[] = [];
  for (const match of allMatches) {
    const customer = typeof match.customer === 'string' ? match.customer : match.customer.id;
    if (customer === opts.stripeCustomerId) continue;
    await deps.stripe.subscriptions.cancel(match.id, { prorate: false });
    deps.log.info('provision.clean_orphan.stripe_canceled', {
      tenantId: opts.tenantId,
      subscriptionId: match.id,
      customer,
    });
    orphanIds.push(match.id);
  }

  // 3. Local mirror cleanup — flip any non-terminal rows for this tenant.
  const localRes = await client.query<{ stripe_subscription_id: string }>( // rls-fence: allow (client scoped by provisionForTenant, which wraps this in withBillingTenant)
    `UPDATE subscriptions
        SET status      = 'canceled',
            canceled_at = COALESCE(canceled_at, NOW()),
            updated_at  = NOW()
      WHERE tenant_id = $1
        AND status NOT IN ('canceled', 'incomplete_expired')
      RETURNING stripe_subscription_id`,
    [opts.tenantId],
  );
  const localCanceled = localRes.rows.map((r) => r.stripe_subscription_id);
  // Always log the outcome — the empty-array case is meaningful too (it
  // proves the cleanup ran, found no stale rows, and finished cleanly).
  // Plan: "Log provision.clean_orphan.local_canceled with returned IDs."
  deps.log.info('provision.clean_orphan.local_canceled', {
    tenantId: opts.tenantId,
    stripeSubscriptionIds: localCanceled,
  });

  // 4. Audit-trail outbox event. Per Q5, this rides billing-events-${env}
  // via attribute filtering — no Terraform change. Per Q14, it has real
  // consumers (90-day outbox retention for forensic queries; future ops
  // dashboards may key on it).
  await enqueueOutboxEvent(
    client,
    makeEnvelope(opts.tenantId, 'billing.provision.orphan_state_cleaned', {
      tenantId: opts.tenantId,
      stripeCustomerIdIntended: opts.stripeCustomerId,
      orphanStripeSubsCancelled: orphanIds,
      localRowsCancelled: localCanceled,
    }),
  );
}
