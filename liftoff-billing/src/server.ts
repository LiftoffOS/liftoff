// Fastify server bootstrap for liftoff-billing.
//
// Mount order (plan 0k / 0r):
//   1. requestCorrelationPlugin — trace/request/tenant header
//      propagation + per-request child logger.
//   2. /health + /ready routes — readiness flag driven by
//      @liftoffos/service-runtime.installSigtermHandler.
//   3. /stripe/webhook — public (ingress=all), raw-body content parser.
//   4. cross-service-auth middleware for /rpc/* (Connect-RPC) and
//      /api/* paths.
//   5. Connect-RPC router.

import Fastify, { type FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { PubSub } from '@google-cloud/pubsub';
import {
  installSigtermHandler,
  createReadinessRoutes,
} from '@liftoffos/service-runtime';
import { loadConfig } from './infrastructure/config.js';
import { getPool, closePool } from './infrastructure/database.js';
import {
  registerStripeWebhook,
  loadWebhookSecrets,
} from './webhooks/stripe-handler.js';
import { startOutboxPublisher, stopOutboxPublisher } from './outbox/worker.js';
import { registerRpcRoutes } from './rpc/router.js';
import { registerStripeEventProcessor } from './consumers/stripe-event-processor.js';
import { buildStripeUsageClient } from './infrastructure/metronome-client.js';
import { PlatformBackendClient } from './infrastructure/platform-backend-client.js';
import { registerBillingAccountsRouter } from './billing-accounts-router.js';
import { ignoreContentTypeWithoutBody } from './infrastructure/empty-body.js';
import { registerInternalAdminRouter } from './routes/internal-admin-router.js';
import { registerCardExpiringRemindersRouter } from './jobs/card-expiring-reminders.js';
import { registerTestSubscriptionRefreshRouter } from './jobs/test-subscription-refresh.js';
import { registerSubscriptionReconciliationRouter } from './jobs/subscription-reconciliation.js';
import { registerSubscriptionReplaceRouter } from './routes/subscription-replace.js';
import { ReferralCreditService } from './referrals/service.js';
import { registerReferralsInternalRouter } from './referrals/internal-router.js';

export async function buildApp(): Promise<FastifyInstance> {
  const config = loadConfig();
  const app = Fastify({
    logger: {
      level: config.ENVIRONMENT === 'prod' ? 'info' : 'debug',
      formatters: {
        level: (label) => ({ level: label }),
      },
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    },
    bodyLimit: 1_000_000, // 1 MB
  });

  // Dependencies the routes need.
  const pool = await getPool();
  const billingServiceToken = await resolveBillingServiceToken();
  const pbClient = new PlatformBackendClient(config.PLATFORM_BACKEND_URL, billingServiceToken);
  const stripeApiKey = await resolveStripeApiKey();
  const stripe = new Stripe(stripeApiKey, {
    apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    // Phase 0q hook — retries + timeout are handled by CallPolicy at
    // the caller side for cross-service RPC; Stripe's own network
    // layer uses its SDK's built-in retry.
    maxNetworkRetries: 3,
    timeout: 10_000,
  });
  syncStripeProductNames(stripe).catch(() => {}); // fire-and-forget, non-blocking
  const pubsub = new PubSub({ projectId: config.GCP_PROJECT_ID });
  void pubsub; // wired via outbox worker below
  if (!config.STRIPE_OU_PRICE_ID && process.env.NODE_ENV !== 'test') {
    app.log.warn('STRIPE_OU_PRICE_ID is not configured — OU metered billing will not attach to new subscriptions. Set _STRIPE_OU_PRICE_ID in Cloud Build trigger substitutions.');
  }
  const stripeUsage = buildStripeUsageClient(stripe, config.STRIPE_OU_PRICE_ID);

  // Readiness + SIGTERM drain (Phase 0r).
  const controls = installSigtermHandler({
    gracePeriodMs: 30_000,
    drainFns: [
      () => stopOutboxPublisher(),
      () => closePool(),
    ],
    inflightCountFn: () => app.server.connections ?? 0,
    logger: {
      info: (m, meta) => app.log.info({ ...meta }, m),
      warn: (m, meta) => app.log.warn({ ...meta }, m),
      error: (m, meta) => app.log.error({ ...meta }, m),
    },
  });
  ignoreContentTypeWithoutBody(app);

  const routes = createReadinessRoutes(controls);
  app.get('/health', (_req, reply) => routes.health(_req, reply));
  app.get('/ready', (_req, reply) => routes.ready(_req, reply));

  // Stripe webhook raw-buffer application/json parser — scoped plugin so the
  // parser doesn't leak to sibling plugins (specifically Connect-RPC).
  const webhookSecrets = await loadWebhookSecrets();
  void app.register(async (sub) => {
    registerStripeWebhook(sub, {
      pool,
      stripe,
      webhookSecrets,
      toleranceSeconds: config.STRIPE_WEBHOOK_TOLERANCE_SECONDS,
      log: {
        info: (m, meta) => app.log.info({ ...meta }, m),
        warn: (m, meta) => app.log.warn({ ...meta }, m),
        error: (m, meta) => app.log.error({ ...meta }, m),
      },
    });
  });

  // The referral programme's money half. One instance, shared by the Stripe
  // consumer (which earns, applies and reverses) and the daily maintenance job
  // (which vests and expires), because both act on the same rows and there is
  // no state worth duplicating between them.
  const referralLog = {
    info: (m: string, meta?: object) => app.log.info({ ...meta }, m),
    warn: (m: string, meta?: object) => app.log.warn({ ...meta }, m),
    error: (m: string, meta?: object) => app.log.error({ ...meta }, m),
  };
  const referrals = new ReferralCreditService(stripe, pbClient, referralLog);

  // Pub/Sub push consumer — translates billing.stripe.* outbox events
  // into canonical billing.* events + state writes.
  registerStripeEventProcessor(app, {
    pool,
    pbClient,
    stripe,
    stripeUsage,
    referrals,
    log: {
      info: (m, meta) => app.log.info({ ...meta }, m),
      warn: (m, meta) => app.log.warn({ ...meta }, m),
      error: (m, meta) => app.log.error({ ...meta }, m),
    },
  });

  // Billing accounts REST endpoints (Phase 1: read-only billing UI).
  // Includes /current-usage (replaces the inline endpoint that was here).
  registerBillingAccountsRouter(app, {
    pool,
    stripe,
    pbClient,
    billingServiceToken,
    log: {
      info: (m, meta) => app.log.info({ ...meta }, m),
      warn: (m, meta) => app.log.warn({ ...meta }, m),
      error: (m, meta) => app.log.error({ ...meta }, m),
    },
  });

  registerInternalAdminRouter(app, {
    stripe,
    pool,
    billingServiceToken,
    ouPriceId: config.STRIPE_OU_PRICE_ID,
    pbClient,
  });

  registerCardExpiringRemindersRouter(app, { pool, pbClient, billingServiceToken });

  // Referral programme: the two reads platform-backend needs to render
  // /dashboard/refer, plus the daily vesting-and-expiry sweep.
  registerReferralsInternalRouter(app, {
    service: referrals,
    billingServiceToken,
    log: referralLog,
  });

  // Dev-only: re-provisions test-mode subs before Stripe's 90-day retention
  // auto-cancel kills them (hard-gated to sk_test_ keys inside the handler).
  registerTestSubscriptionRefreshRouter(app, {
    stripe,
    pbClient,
    billingServiceToken,
    isTestMode: stripeApiKey.startsWith('sk_test_'),
  });

  // Daily Stripe↔local subscription drift detection (both envs).
  registerSubscriptionReconciliationRouter(app, {
    stripe,
    pool,
    pbClient,
    billingServiceToken,
  });

  registerSubscriptionReplaceRouter(app, {
    stripe,
    pool,
    billingServiceToken,
    pbClient,
  });

  // Connect-RPC handlers — mounted after cross-service auth.
  registerRpcRoutes(app, { stripe, pool });

  // Kick off outbox publisher.
  await startOutboxPublisher({
    log: {
      info: (obj, msg) => app.log.info(obj, msg),
      warn: (obj, msg) => app.log.warn(obj, msg),
    },
  });

  // Validate Stripe connectivity at startup (BE-017).
  // Full price-ID validation against platform_fee_catalog / addon_catalog
  // is added in Phase 3 once those tables exist.
  await validateStripeConfig(stripe, app.log);

  return app;
}

async function resolveStripeApiKey(): Promise<string> {
  const config = loadConfig();
  if (process.env.NODE_ENV === 'test') {
    return process.env.STRIPE_API_KEY ?? 'sk_test_dummy';
  }
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const [v] = await client.accessSecretVersion({
    name: `projects/${config.GCP_PROJECT_ID}/secrets/${config.STRIPE_API_KEY_SECRET}/versions/latest`,
  });
  const raw = v.payload?.data;
  return raw ? (typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8')) : '';
}

async function resolveBillingServiceToken(): Promise<string> {
  const config = loadConfig();
  if (process.env.NODE_ENV === 'test') {
    return process.env.BILLING_SERVICE_TOKEN ?? 'test_billing_token';
  }
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const smClient = new SecretManagerServiceClient();
  const [v] = await smClient.accessSecretVersion({
    name: `projects/${config.GCP_PROJECT_ID}/secrets/${config.BILLING_SERVICE_TOKEN_SECRET}/versions/latest`,
  });
  const raw = v.payload?.data;
  return raw ? (typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8')) : '';
}

// Sync Stripe product names for admin-provisioned plan price IDs at startup.
// Updates the product name on each configured plan price so invoices show
// consistent, human-readable names regardless of provisioning path.
// Fire-and-forget — failures are logged but do not block startup.
async function syncStripeProductNames(stripe: Stripe): Promise<void> {
  const PLAN_PRICE_NAMES: Array<{ envVar: string; name: string }> = [
    { envVar: 'STRIPE_PLAN_CORE_MONTHLY_PRICE_ID',   name: 'Core (monthly) plan' },
    { envVar: 'STRIPE_PLAN_CORE_ANNUAL_PRICE_ID',    name: 'Core (annual) plan' },
    { envVar: 'STRIPE_PLAN_GROWTH_MONTHLY_PRICE_ID', name: 'Growth (monthly) plan' },
    { envVar: 'STRIPE_PLAN_GROWTH_ANNUAL_PRICE_ID',  name: 'Growth (annual) plan' },
    { envVar: 'STRIPE_PLAN_SCALE_MONTHLY_PRICE_ID',  name: 'Scale (monthly) plan' },
    { envVar: 'STRIPE_PLAN_SCALE_ANNUAL_PRICE_ID',   name: 'Scale (annual) plan' },
  ];
  for (const { envVar, name } of PLAN_PRICE_NAMES) {
    const priceId = process.env[envVar];
    if (!priceId) continue;
    try {
      const price = await stripe.prices.retrieve(priceId);
      await stripe.products.update(typeof price.product === 'string' ? price.product : price.product.id, { name });
    } catch (err) {
      console.error(`syncStripeProductNames: failed to update ${envVar}:`, err);
    }
  }
}

// Validate Stripe API connectivity at startup (BE-017 — Phase 2).
// Ensures the configured Stripe key is valid and the API is reachable before
// the service starts accepting traffic. Throws on hard failures (invalid key);
// logs warnings on transient network errors so a temporary Stripe outage
// doesn't block a rolling restart.
//
// Phase 3 extension: once platform_fee_catalog and addon_catalog exist,
// add a second pass that retrieves each stripe_price_id and asserts it is active.
async function validateStripeConfig(
  stripe: Stripe,
  log: { info: (msg: string, meta?: object) => void; warn: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void },
): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const account = await stripe.accounts.retrieve();
    log.info('stripe connectivity verified', { accountId: account.id });
  } catch (err) {
    const stripeErr = err as Stripe.errors.StripeError;
    if (stripeErr.type === 'StripeAuthenticationError') {
      throw new Error(`Invalid Stripe API key — liftoff-billing cannot start. Check ${process.env.STRIPE_API_KEY_SECRET ?? 'stripe-secret-key'} in Secret Manager.`);
    }
    // Transient network issues shouldn't block a rolling restart.
    log.warn('stripe connectivity check failed (non-fatal)', { error: (err as Error).message });
  }
}

export async function start(): Promise<void> {
  const app = await buildApp();
  const config = loadConfig();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info({ port: config.PORT }, 'liftoff-billing listening');
}
