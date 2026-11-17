#!/usr/bin/env node
// Carry a change in `SELF_SERVE_PLANS.basePlanOus` onto subscriptions that
// already exist.
//
// WHY A SCRIPT AND NOT A MIGRATION. A self-serve subscription's allowance does
// not live in a database we own. `basePlanOus` is stamped into the Stripe
// subscription's `included_ous` metadata at subscribe time, and
// `stripe-event-processor` reads it back off the subscription on every
// `customer.subscription.*` event and forwards it to platform-backend's
// `subscription-activated`, which writes `billing_controls.plan_included_ous`.
// Stripe metadata is therefore the durable copy: a subscription created before
// a repricing carries the old number, and a platform-backend migration that
// updates `billing_controls` is reverted the next time that subscription emits
// an event. Run this whenever `basePlanOus` changes.
//
// WHAT IT CHANGES, per subscription:
//   included_ous   old base -> new base
//   committed_ous  += the same delta   (it is base + extras; the extras must not move)
//   precommit_extra_ous                UNTOUCHED
//
// It does NOT change the subscription's price. A repricing that holds the
// monthly fee fixed and moves the allowance leaves every Stripe price object
// valid, which is the only reason this can be a metadata edit at all.
//
// PRECONDITION — READ BEFORE RUNNING WITH --apply. A metadata write emits
// `customer.subscription.updated`, and platform-backend's
// `subscription-activated` handler unconditionally zeroes
// `ous_consumed_this_period`, `current_period_spend_usd` and
// `referral_bonus_ous` for the account. Consumption zeroing is harmless in the
// generous direction; a non-zero `referral_bonus_ous` is a granted entitlement
// and would be destroyed. Confirm it is zero for every affected account first:
//
//   SELECT account_id, referral_bonus_ous FROM billing_controls
//    WHERE plan_type IS NOT NULL AND referral_bonus_ous > 0;
//
// IT REFUSES A SUBSCRIPTION THAT HAS PRECOMMIT EXTRAS and reports it instead.
// Extras are priced at `PRECOMMIT_CENTS_PER_OU` and baked into the
// subscription's price, so if that rate moved the price is wrong until a new
// Stripe price object is created and swapped in. That is a charge change, which
// is a decision for a person rather than a side effect of a backfill.
//
// DRY RUN BY DEFAULT. Pass --apply to write. Idempotent: a subscription whose
// included_ous is already the new base is skipped, so re-running is a no-op.
//
// Run:
//   STRIPE_API_KEY=$(gcloud secrets versions access latest \
//     --secret=stripe-api-key-dev --project=YOUR_CONTROL_PROJECT_STAGING) \
//   npx tsx scripts/backfill-repriced-allowances.ts            # dry run
//   ... npx tsx scripts/backfill-repriced-allowances.ts --apply

import Stripe from 'stripe';

/** old base -> new base, by plan. Keyed on the OLD value so a subscription that
 *  carries anything else (hand-set, already migrated, enterprise) is left
 *  alone rather than forced onto a plan default it never had. */
const ALLOWANCE_MIGRATION: Record<string, { oldBase: number; newBase: number }> = {
  core:   { oldBase: 800,  newBase: 1400  },
  growth: { oldBase: 2150, newBase: 3650  },
  scale:  { oldBase: 9200, newBase: 15200 },
};

interface Outcome {
  id: string;
  tenantId: string;
  planType: string;
  action: 'updated' | 'already-new' | 'skipped-extras' | 'skipped-unrecognised' | 'skipped-not-self-serve';
  detail: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey) throw new Error('STRIPE_API_KEY env var is required');
  const stripe = new Stripe(apiKey, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });

  const outcomes: Outcome[] = [];

  // `status: 'all'` deliberately: a past_due or paused subscription is still a
  // live commercial relationship and will emit events again. A canceled one
  // will not, so it is filtered below rather than rewritten.
  for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') continue;

    const md = sub.metadata ?? {};
    const planType = md.plan_type ?? '';
    const tenantId = md.tenant_id ?? '(no tenant_id)';
    const migration = ALLOWANCE_MIGRATION[planType];

    // Enterprise and anything without a self-serve plan_type: not ours to move.
    // Enterprise allowances come from a bespoke contract via
    // /api/internal/provision-enterprise, not from SELF_SERVE_PLANS.
    //
    // Counted rather than skipped in silence: "0 examined" has to mean "nothing
    // to do" and not "the filter matched nothing", and those read identically
    // from a bare continue.
    if (!migration) {
      outcomes.push({ id: sub.id, tenantId, planType: planType || '(none)', action: 'skipped-not-self-serve',
        detail: `plan_type=${planType || '(absent)'}: allowance is not SELF_SERVE_PLANS' to set` });
      continue;
    }

    const includedOus = Number.parseInt(md.included_ous ?? '', 10);
    const committedOus = Number.parseInt(md.committed_ous ?? '', 10);
    const extras = Number.parseInt(md.precommit_extra_ous ?? '0', 10) || 0;

    if (includedOus === migration.newBase) {
      outcomes.push({ id: sub.id, tenantId, planType, action: 'already-new',
        detail: `included_ous already ${migration.newBase}` });
      continue;
    }
    if (includedOus !== migration.oldBase) {
      outcomes.push({ id: sub.id, tenantId, planType, action: 'skipped-unrecognised',
        detail: `included_ous=${md.included_ous ?? '(absent)'} is neither the old base (${migration.oldBase}) nor the new (${migration.newBase})` });
      continue;
    }
    if (extras > 0) {
      outcomes.push({ id: sub.id, tenantId, planType, action: 'skipped-extras',
        detail: `precommit_extra_ous=${extras}: extras are priced into the subscription, so its price needs re-deriving and a new price object swapped in. Needs a decision, not a backfill.` });
      continue;
    }

    const delta = migration.newBase - migration.oldBase;
    // committed_ous is base + extras. With extras at 0 it equals the base, but
    // it is computed from what is actually there rather than assumed, so the
    // arithmetic stays right if the extras refusal above is ever relaxed.
    const newCommitted = Number.isFinite(committedOus) ? committedOus + delta : migration.newBase;

    if (apply) {
      await stripe.subscriptions.update(sub.id, {
        metadata: {
          ...md,
          included_ous:  String(migration.newBase),
          committed_ous: String(newCommitted),
        },
      });
    }
    outcomes.push({ id: sub.id, tenantId, planType, action: 'updated',
      detail: `included_ous ${migration.oldBase} -> ${migration.newBase}, committed_ous ${committedOus} -> ${newCommitted}` });
  }

  const by = (a: Outcome['action']) => outcomes.filter(o => o.action === a);
  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN (pass --apply to write)'} — ${outcomes.length} live subscription(s) examined\n`);
  for (const o of outcomes) {
    console.log(`  [${o.action}] ${o.planType} ${o.id} tenant=${o.tenantId}\n      ${o.detail}`);
  }
  console.log(`\n  updated: ${by('updated').length}   already-new: ${by('already-new').length}   ` +
              `not-self-serve: ${by('skipped-not-self-serve').length}   ` +
              `skipped-extras: ${by('skipped-extras').length}   skipped-unrecognised: ${by('skipped-unrecognised').length}\n`);

  // A refusal is the reason this script prints a non-zero exit: it is the one
  // outcome that needs a person, and a backfill that scrolls past in CI output
  // is a backfill nobody reads.
  if (by('skipped-extras').length > 0 || by('skipped-unrecognised').length > 0) {
    console.error('Some subscriptions need a decision — see skipped- rows above.');
    process.exit(2);
  }
}

main().catch((err: Error) => { console.error(err); process.exit(1); });
