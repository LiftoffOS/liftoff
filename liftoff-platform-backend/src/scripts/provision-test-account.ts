// Provision a Core-monthly test account in a production deployment.
//
// Primary use case: connector OAuth App Reviewers (Slack, Google,
// Microsoft, etc.) need a real, working Liftoff account to sign in to during
// their integration reviews. Same shape works for any internal test workspace
// that needs a real signed-in user without producing real charges.
//
// Constraints:
//   - Sign-in via email + password (not magic link — reviewers don't have
//     access to the inbox).
//   - Workspace must already be past onboarding (no first-run wizard).
//   - Plan tier is Core monthly — the default self-serve plan a real customer
//     gets. No enterprise contract, no special billing_tier override.
//   - $0 ongoing charges — a permanent 100%-off Stripe coupon is attached to
//     the subscription so every invoice settles at zero.
//
// Steps:
//   1. Create Firebase user (email + password, emailVerified=true).
//   2. AccountService.create — account row + Stripe customer.
//   3. TenantService.provision — tenant + member + entitlement + activate +
//      Core monthly Stripe subscription (via billing-service
//      /api/internal/provision-subscription, which defaults to Core monthly).
//   4. Mark onboarding complete (tenants.onboarding_completed_at = NOW()).
//   5. Look up the active Stripe subscription on the customer; ensure a
//      100%-off forever coupon exists; attach it.
//
// One invocation per account. Prints a JSON line to stdout with the
// credentials on success; store them somewhere safe, such as a password manager.
//
// Required env:
//   DATABASE_URL                    — control-plane Postgres URL
//   STRIPE_SECRET_KEY               — prod Stripe key
//   FIREBASE_PROJECT_ID             — e.g. "YOUR_WEB_PROJECT"
//   GOOGLE_APPLICATION_CREDENTIALS  — path to Firebase service-account JSON
//                                     (or rely on ADC if running locally with
//                                     gcloud auth application-default login)
//   BILLING_SERVICE_URL             — prod liftoff-billing internal URL
//   BILLING_SERVICE_TOKEN           — prod billing service token (also HMAC key)
//   SHARED_RUNTIME_URL              — prod shared tenant-runtime URL
//
// CLI args (positional, all required):
//   <email> <first-name> <last-name> <workspace-name> <contract-reference>
//
// Run locally against prod (needs Cloud SQL Auth Proxy):
//   DATABASE_URL=postgres://... \
//   STRIPE_SECRET_KEY=sk_live_... \
//   FIREBASE_PROJECT_ID=YOUR_WEB_PROJECT \
//   BILLING_SERVICE_URL=https://billing-... \
//   BILLING_SERVICE_TOKEN=... \
//   SHARED_RUNTIME_URL=https://... \
//   npx ts-node src/scripts/provision-test-account.ts \
//     slack@example.com Slack Reviewer "Slack OAuth App Review" \
//     oauth-app-review-slack

import crypto from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import Stripe from 'stripe';

import { initDatabase, closePools, getPool } from '../infrastructure/database';
import { initFirebase } from '../infrastructure/firebase';
import { log } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { TenantService } from '../tenants/service';
import { getStripeSecretKey } from '../infrastructure/secrets';

// Stable coupon ID for the comp. Idempotent: the script creates the coupon
// only if it doesn't already exist, then attaches it to the new subscription.
// `duration: 'forever'` keeps every invoice at $0 for the life of the
// subscription (no expiry, no max_redemptions).
const COMP_COUPON_ID = 'oauth-app-review-100-off';
const COMP_COUPON_NAME = 'OAuth App Review — 100% off (forever)';

interface CliArgs {
  email: string;
  firstName: string;
  lastName: string;
  workspaceName: string;
  contractReference: string;
}

function parseArgs(): CliArgs {
  const [email, firstName, lastName, workspaceName, contractReference] = process.argv.slice(2);
  if (!email || !firstName || !lastName || !workspaceName || !contractReference) {
    throw new Error(
      'usage: provision-test-account.ts <email> <first-name> <last-name> <workspace-name> <contract-reference>',
    );
  }
  if (!email.toLowerCase().endsWith('@example.com')) {
    throw new Error('refusing to create test account outside @example.com');
  }
  return { email, firstName, lastName, workspaceName, contractReference };
}

// 32 chars from a URL-safe alphabet — plenty of entropy for a long-lived
// shared credential without including symbols a human might mistype.
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(32);
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

// Idempotent: return the comp coupon if it already exists, otherwise create it.
async function ensureCompCoupon(stripe: Stripe): Promise<Stripe.Coupon> {
  try {
    return await stripe.coupons.retrieve(COMP_COUPON_ID);
  } catch (err) {
    if ((err as Stripe.errors.StripeError).code !== 'resource_missing') throw err;
  }
  return stripe.coupons.create({
    id: COMP_COUPON_ID,
    name: COMP_COUPON_NAME,
    percent_off: 100,
    duration: 'forever',
    metadata: { purpose: 'oauth-app-review-test-accounts' },
  });
}

async function main(): Promise<number> {
  // initDatabase reads either DB_HOST or CLOUD_SQL_CONNECTION_NAME (Unix
  // socket); we only need one. The Cloud Run Job pattern uses the socket.
  if (!process.env.DB_HOST && !process.env.CLOUD_SQL_CONNECTION_NAME) {
    throw new Error('missing required env: DB_HOST or CLOUD_SQL_CONNECTION_NAME');
  }
  for (const name of [
    'DB_USER',
    'DB_NAME',
    'DB_PASSWORD',
    'STRIPE_SECRET_KEY',
    'FIREBASE_PROJECT_ID',
    'BILLING_SERVICE_URL',
    'BILLING_SERVICE_TOKEN',
    'SHARED_RUNTIME_URL',
  ]) {
    requireEnv(name);
  }

  const args = parseArgs();
  const password = generatePassword();

  await initDatabase();
  await initFirebase();

  // 1. Firebase user. emailVerified=true so the frontend doesn't gate the
  //    account behind a confirmation email the reviewer can't read.
  const firebaseUser = await getAuth().createUser({
    email: args.email,
    password,
    emailVerified: true,
    displayName: `${args.firstName} ${args.lastName}`,
    disabled: false,
  });
  log.info({ email: args.email, uid: firebaseUser.uid }, 'firebase user created');

  // 2. Account row + Stripe customer (atomic — see AccountService.create).
  const accountService = new AccountService();
  const account = await accountService.create({
    firebaseUid: firebaseUser.uid,
    firstName: args.firstName,
    lastName: args.lastName,
    email: args.email,
  });
  log.info(
    { accountId: account.id, stripeCustomerId: account.stripeCustomerId },
    'account + stripe customer created',
  );

  // 3. Attach the 100%-off coupon to the Stripe customer BEFORE provisioning
  //    the subscription. The Core monthly price ($20/mo) requires a payment
  //    method on the customer unless the first invoice nets to $0. Attaching
  //    the coupon at customer level makes Stripe apply it to every subscription
  //    created for this customer, so the initial invoice is $0 and provisioning
  //    succeeds without a card on file.
  const stripeKey = await getStripeSecretKey();
  const stripe = new Stripe(stripeKey);
  if (!account.stripeCustomerId) {
    throw new Error('account missing stripe_customer_id after create — cannot continue');
  }
  const coupon = await ensureCompCoupon(stripe);
  await stripe.customers.update(account.stripeCustomerId, { coupon: coupon.id });
  log.info({ stripeCustomerId: account.stripeCustomerId, couponId: coupon.id }, 'coupon attached to customer');

  // 4. Tenant. provision() activates and synchronously calls
  //    billing-service /api/internal/provision-subscription, which provisions a
  //    real Core monthly Stripe subscription. With the coupon already on the
  //    customer, the initial invoice is $0 → no payment method required.
  const tenantService = new TenantService();
  const tenant = await tenantService.provision({
    accountId: account.id,
    name: args.workspaceName,
  });
  log.info({ tenantId: tenant.id }, 'tenant provisioned + activated (Core monthly sub)');

  // 5. Skip onboarding. onboarding_step=6 matches the post-onboarding state
  //    set by migration 202's backfill for pre-existing tenants.
  const pool = getPool();
  await pool.query(
    `UPDATE tenants SET onboarding_completed_at = NOW(), onboarding_step = 6 WHERE id = $1`,
    [tenant.id],
  );
  log.info({ tenantId: tenant.id }, 'onboarding marked complete');

  // 6. Look up the resulting Stripe subscription for the credentials record.
  const subs = await stripe.subscriptions.list({
    customer: account.stripeCustomerId,
    status: 'active',
    limit: 10,
  });

  // 7. Print credentials JSON line to stdout for the operator.
  const record = {
    purpose: args.contractReference,
    email: args.email,
    password,
    firebaseUid: firebaseUser.uid,
    accountId: account.id,
    tenantId: tenant.id,
    stripeCustomerId: account.stripeCustomerId,
    stripeSubscriptionIds: subs.data.map((s) => s.id),
    couponId: coupon.id,
    createdAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(record));
  return 0;
}

main()
  .then(async (code) => {
    await closePools();
    process.exit(code);
  })
  .catch(async (err) => {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'provision failed');
    await closePools().catch(() => undefined);
    process.exit(1);
  });
