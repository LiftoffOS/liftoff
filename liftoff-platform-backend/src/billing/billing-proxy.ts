// Billing forwarding proxy — unconditional (Phase 4: cutover complete).
//
// All /api/billing/* traffic is forwarded verbatim to liftoff-billing.
// Uses ServiceClient for keep-alive, request timeout, circuit breaker, and OIDC auth.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { ServiceClient, CircuitBreaker } from '@liftoffos/service-client';
import { log, logAudit } from '../infrastructure/logging';
import { getPool, withAdminScope } from '../infrastructure/database';

// Phase 2 of the unified workspace audit: user-initiated billing mutations
// surface in `/dashboard/settings/workspace` → Audit Logs.
//
// platform-backend reverse-proxies these calls to liftoff-billing, so the
// cleanest insertion point is here — we know req.ctx + verified tenant
// membership (the 403 guard above runs before this) AND we see the
// upstream response code, so we can audit only on success.
//
// Stripe-webhook-initiated changes never traverse this proxy (they go
// directly to liftoff-billing's webhook router), so there's no risk of
// auto-attributing non-human actions to a user.
//
// Rule paths are EXACT matches against `req.path` after the
// `/accounts/:tenantId` prefix is stripped. Any sub-resource (e.g.
// `/payment-methods/:id`) needs its own rule — no endsWith / startsWith
// fuzziness so we don't accidentally match unintended endpoints.
//
// Sourced from liftoff-billing/src/billing-accounts-router.ts. Any new user-initiated billing endpoint MUST be added
// here at the same time to keep workspace audit coverage complete.
interface BillingAuditRule {
  method: string;
  exact: string;
  eventType: string;
}

const BILLING_AUDIT_RULES: BillingAuditRule[] = [
  // Subscription lifecycle
  { method: 'POST', exact: '/subscribe', eventType: 'billing.subscription_created' },
  { method: 'POST', exact: '/replace-subscription', eventType: 'billing.subscription_replaced' },
  { method: 'POST', exact: '/change-plan', eventType: 'billing.plan_changed' },
  { method: 'POST', exact: '/cancel-subscription', eventType: 'billing.subscription_cancelled' },
  // Payment methods
  { method: 'POST', exact: '/setup-intent', eventType: 'billing.payment_method_setup_started' },
  { method: 'POST', exact: '/checkout-session', eventType: 'billing.checkout_session_started' },
  { method: 'PATCH', exact: '/default-payment-method', eventType: 'billing.default_payment_method_updated' },
  // Auto-reload
  { method: 'PUT', exact: '/auto-reload', eventType: 'billing.auto_reload_updated' },
  { method: 'PATCH', exact: '/auto-reload', eventType: 'billing.auto_reload_updated' },
  { method: 'DELETE', exact: '/auto-reload', eventType: 'billing.auto_reload_disabled' },
  // Recovery
  { method: 'POST', exact: '/retry-outstanding-charge', eventType: 'billing.outstanding_charge_retried' },
];

function matchBillingAuditRule(method: string, pathAfterTenant: string): BillingAuditRule | null {
  for (const rule of BILLING_AUDIT_RULES) {
    if (rule.method === method && rule.exact === pathAfterTenant) {
      return rule;
    }
  }
  return null;
}

// Resolve workspace member account id from the verified Firebase UID, so the
// audit row records who actually clicked the button rather than the Firebase
// principal id (which the audit log treats as opaque).
async function resolveAccountIdByFirebaseUid(firebaseUid: string): Promise<string | null> {
  const r = await withAdminScope(
    {
      caller: 'billing-proxy.audit',
      reason: 'audit attribution — pre-tenant context',
    },
    (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM accounts WHERE firebase_uid = $1 LIMIT 1`,
        [firebaseUid],
      ),
  ).catch(() => ({ rows: [] as { id: string }[] }));
  return r.rows[0]?.id ?? null;
}

// Pattern for tenant-scoped billing routes: /api/billing/accounts/:tenantId/...
// The proxy is mounted at /api/billing so req.path is /accounts/:tenantId/...
const TENANT_BILLING_ROUTE = /^\/accounts\/([^/?]+)\//;

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',  // ServiceClient.buildHeaders always sets Content-Type; forwarding
                   // the browser's lowercase 'content-type' alongside it creates two
                   // entries with different cases → Fastify gets "application/json,
                   // application/json" → 415 Unsupported Media Type.
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'authorization',
  'x-service-auth',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

let _billingClient: ServiceClient | null = null;
function getBillingClient(targetBaseUrl: string): ServiceClient {
  if (!_billingClient) {
    _billingClient = new ServiceClient({
      serviceAuthEnvVar: 'BILLING_SERVICE_TOKEN',
      resolveTargetUrl: async () => targetBaseUrl,
      breaker: new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 }),
      onLog: (level, ctx, msg) => log[level](ctx, msg),
    });
  }
  return _billingClient;
}

// Resolves the active Stripe customer ID for a tenant.
// Returns both stripe_customer_id and account email so callers can backfill
// missing email on the Stripe customer when needed (Embedded Checkout shows an
// editable email field whenever the passed customer has no email).
async function resolveAccountBillingContext(
  tenantId: string,
): Promise<{ stripeCustomerId: string | null; email: string | null }> {
  const pool = getPool();
  const { rows } = await pool.query<{ stripe_customer_id: string | null; email: string | null }>(
    `SELECT COALESCE(bc.stripe_customer_id, a.stripe_customer_id) AS stripe_customer_id,
            a.email                                              AS email
     FROM tenants t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN billing_controls bc ON bc.account_id = a.id
     WHERE t.id = $1`,
    [tenantId],
  );
  return {
    stripeCustomerId: rows[0]?.stripe_customer_id ?? null,
    email: rows[0]?.email ?? null,
  };
}

export function createBillingProxyRouter(opts: { targetBaseUrl?: string } = {}): Router {
  const router = Router();

  router.all('*', async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    // 1D: Tenant membership guard for /api/billing/accounts/:tenantId/* routes.
    // authMiddleware already verified the Firebase JWT; here we verify the user
    // is a member of the requested tenant before forwarding billing data.
    const tenantMatch = req.path.match(TENANT_BILLING_ROUTE);
    if (tenantMatch) {
      const tenantId = tenantMatch[1];
      const firebaseUid = req.ctx?.userId;
      if (!firebaseUid) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      // Auth-lookup pattern (same as tenantMembersService.findMembership):
      // pre-tenant-context membership check. tenant_members is RLS-on
      // (migration 095); accounts is RLS-excluded. withAdminScope so the
      // lookup works once FORCE RLS is enabled (plan §0.4). Query is
      // naturally scoped by (tenant_id, firebase_uid) so admin bypass
      // exposes no cross-tenant data.
      const { rows } = await withAdminScope(
        {
          caller: 'billing-proxy.tenantMembershipGuard',
          reason: 'auth lookup — tenant context not yet established',
        },
        (client) =>
          client.query<{ n: string }>(
            `SELECT 1 AS n FROM tenant_members tm
             JOIN accounts a ON a.id = tm.account_id
             WHERE tm.tenant_id = $1 AND a.firebase_uid = $2
             LIMIT 1`,
            [tenantId, firebaseUid],
          ),
      ).catch(() => ({ rows: [] as { n: string }[] }));
      if (rows.length === 0) {
        res.status(403).json({ error: 'access_denied' });
        return;
      }
    }

    const targetBase = (opts.targetBaseUrl ?? process.env.BILLING_SERVICE_URL ?? '').replace(/\/$/, '');
    if (!targetBase) {
      log.error({ path: req.path }, 'billing.proxy: BILLING_SERVICE_URL not configured');
      res.status(503).json({ error: 'billing_proxy_misconfigured' });
      return;
    }

    const client = getBillingClient(targetBase);

    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP_REQUEST_HEADERS.has(k.toLowerCase()) && typeof v === 'string') {
        forwardHeaders[k] = v;
      }
    }

    // Inject x-account-stripe-customer-id for routes that need it to fall back gracefully
    // when no active subscription exists yet (new workspace) or for Checkout deduplication.
    const needsCustomerHeader =
      (req.method === 'POST' && req.path.endsWith('/setup-intent')) ||
      (req.method === 'POST' && req.path.endsWith('/checkout-session')) ||
      // First-time self-serve subscription via the fused-onboarding payment
      // step. The subscriptions table is empty for this tenant until /subscribe
      // succeeds; without this header, liftoff-billing's /subscribe returns
      // no_stripe_customer even though the SetupIntent for the same customer
      // just succeeded.
      (req.method === 'POST' && req.path.endsWith('/subscribe')) ||
      (req.method === 'PATCH' && req.path.endsWith('/default-payment-method')) ||
      // A workspace funding itself with credit instead of subscribing. Every
      // route below resolves its Stripe customer from liftoff-billing's own
      // `subscriptions` table, which is empty for such a workspace, so without
      // the header they answer 404 or with unprovisioned defaults — and the
      // four of them are what make credit buyable and visible:
      //   /credits         buying it
      //   /current-usage   returns billingMode, which gates the Credit Balance
      //                    and Auto Reload sections
      //   /payment-methods the add-credit buy button stays disabled with no card
      //   /overview        drives the dashboard notice banner
      // These are GETs, unlike every route above.
      (req.method === 'POST' && req.path.endsWith('/credits')) ||
      (req.method === 'GET' && req.path.endsWith('/current-usage')) ||
      (req.method === 'GET' && req.path.endsWith('/payment-methods')) ||
      (req.method === 'GET' && req.path.endsWith('/overview'));
    const isCheckoutSession = req.path === '/liftoff.billing.v1.BillingService/CreateCheckoutSession';

    if (needsCustomerHeader || isCheckoutSession) {
      // REST routes: tenantId already resolved above via URL regex.
      // Connect-RPC routes: tenantId is in the JSON body (not in the URL).
      const resolveId = isCheckoutSession
        ? (req.body as { tenantContext?: { tenantId?: string } } | undefined)?.tenantContext?.tenantId
        : tenantMatch?.[1];
      if (resolveId) {
        const ctx = await resolveAccountBillingContext(resolveId).catch(() => null);
        if (ctx?.stripeCustomerId) forwardHeaders['x-account-stripe-customer-id'] = ctx.stripeCustomerId;
        if (ctx?.email) forwardHeaders['x-account-email'] = ctx.email;
      }
    }

    const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method);
    let bodyInit: BodyInit | undefined;
    if (hasBody) {
      if (req.body !== undefined) {
        // express.json() already consumed the stream — re-serialize so the proxy
        // can forward it. Without this, req.on('data'/'end') never fires and the
        // request hangs until Cloud Run's 300s timeout kills it.
        const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        bodyInit = Buffer.from(bodyStr);
      } else {
        const buf = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });
        bodyInit = buf as unknown as BodyInit;
      }
    }

    let upstream: globalThis.Response;
    try {
      upstream = await client.fetch('billing', req.originalUrl, {
        method: req.method,
        headers: forwardHeaders,
        body: bodyInit,
        // @ts-expect-error — Node 20 fetch supports duplex
        duplex: hasBody ? 'half' : undefined,
      });
    } catch (err) {
      log.error({ err, path: req.originalUrl }, 'billing.proxy: network error');
      res.status(502).json({ error: 'billing_proxy_error', message: 'Billing is temporarily unavailable. Please try again.' });
      return;
    }

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!HOP_BY_HOP_RESPONSE_HEADERS.has(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    });

    // Phase 2 audit: when a known user-initiated billing endpoint returned
    // 2xx, fire a workspace audit row. Detached from the response path via
    // `setImmediate` so the client never waits on the accountId resolution
    // DB query. Tenant context is verified above (we 403 earlier without
    // it). Firebase UID → accountId resolution runs out-of-band; if it
    // fails the audit row is dropped (logged as warn). The success
    // response has already been piped to the client.
    if (
      upstream.status >= 200 &&
      upstream.status < 300 &&
      tenantMatch
    ) {
      const tenantId = tenantMatch[1];
      const pathAfterTenant = req.path.replace(/^\/accounts\/[^/?]+/, '');
      const rule = matchBillingAuditRule(req.method, pathAfterTenant);
      const firebaseUid = req.ctx?.userId;
      // Snapshot request body BEFORE the body-pipe consumes anything else;
      // we already buffered/forwarded above so this is the same payload
      // the user sent. Truncate to a sane limit to keep audit rows bounded.
      const requestBodySnapshot = (() => {
        try {
          const raw = req.body !== undefined ? JSON.stringify(req.body) : null;
          if (!raw) return null;
          return raw.length > 4096 ? raw.slice(0, 4096) + '…(truncated)' : raw;
        } catch {
          return null;
        }
      })();
      if (rule && firebaseUid) {
        setImmediate(() => {
          void (async () => {
            try {
              const accountId = await resolveAccountIdByFirebaseUid(firebaseUid);
              if (!accountId) return;
              logAudit(
                rule.eventType,
                { ...req.ctx, tenantId, userId: accountId },
                {
                  resourceType: 'billing',
                  resourceId: tenantId,
                  newState: {
                    method: req.method,
                    path: req.path,
                    requestBody: requestBodySnapshot,
                  },
                },
              );
            } catch (err) {
              log.warn(
                { err, path: req.path },
                'billing.proxy: audit emit failed (non-fatal)',
              );
            }
          })();
        });
      }
    }

    if (upstream.body) {
      // The upstream body can fail after the headers: a reset, or the
      // ServiceClient's request timeout, which covers the body read. `pipe`
      // does not forward that error, and an unhandled 'error' on the stream
      // would take the process down.
      const upstreamBody = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
      upstreamBody.on('error', (err: Error) => {
        log.error({ err: err.message, path: req.originalUrl }, 'billing.proxy: upstream body stream error');
        if (!res.headersSent) res.status(502).json({ error: 'billing_proxy_error', message: 'Billing is temporarily unavailable. Please try again.' });
        else res.destroy(err);
      });
      upstreamBody.pipe(res);
    } else {
      res.end();
    }
  });

  return router;
}
