// HTTP server for ConnectorService.
//
// Mount order matters:
//   1. request-id / logging middleware
//   2. /health — public, for Cloud Run startup + load-balancer health checks
//   3. verifyServiceAuth — rejects any request without a valid X-Service-Auth
//      matching CONNECTOR_SERVICE_TOKEN (constant-time compare)
//   4. OAuth / API-key / keypair REST routes (with per-subtree express.json())
//   5. expressConnectMiddleware — mounts every Connect-RPC route defined
//      in src/rpc/router.ts at its proto-derived path (e.g.
//      /liftoff.connector.v1.ConnectorService/Execute)
//   6. 404 fallback — anything else

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { expressConnectMiddleware } from '@connectrpc/connect-express';
import type { Logger } from '@liftoffos/telemetry';
import registerConnectorService from './rpc/router.js';
import { oauthRouter } from './oauth/router.js';
import { apikeyRouter } from './oauth/apikey-router.js';
import { keypairRouter } from './oauth/keypair-router.js';
import { bigqueryRouter } from './oauth/bigquery-router.js';
// Custom API connections — an API a workspace described and connected from a
// conversation. Its own subtree because the flow (describe → capture →
// verify) fits none of the oauth/apikey/keypair shapes, and because its tool
// schemas are PER INSTANCE and cannot travel through ListTools.
import { customApiRouter } from './custom-api/router.js';
import { connectorCrudRouter } from './crud/router.js';
import { connectorAdminRouter } from './crud/admin-router.js';
// Liftoff Switch — credential-less `error` placeholders for imported
// integrations. Separate from the public create endpoint, which deliberately
// accepts only pending/active.
import { connectorImportRouter } from './crud/import-router.js';
import { executeRouter } from './jobs/execute-router.js';
import { x402WalletRouter } from './x402/wallet-router.js';
import { catalogRouter } from './catalog/router.js';
import { platformVendorBalancesRouter } from './clients/platform-vendor-balances-router.js';
import { metaWebhookRouter } from './oauth/meta-webhook-router.js';
import { slackEventsRouter } from './events/slack-webhook-router.js';
import { githubWebhookRouter } from './events/github-webhook-router.js';
import { stripeWebhookRouter } from './events/stripe-webhook-router.js';
import { githubAppInstallRouter } from './oauth/github-app-install-router.js';
import { idempotencyInterceptor } from './infra/idempotency-interceptor.js';

export interface ServerOptions {
  port: number;
  log: Logger;
}

export function buildApp(opts: ServerOptions): Express {
  const app = express();

  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { log: Logger }).log = opts.log.child({
      request_id: (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      method: req.method,
      path: req.path,
    });
    next();
  });

  // Public health endpoint — Cloud Run startup probe + load balancer.
  // Must be mounted BEFORE verifyServiceAuth so the probe doesn't need the
  // service token to succeed.
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'connector-service',
      version: process.env.SERVICE_VERSION ?? '0.1.0',
      commit: process.env.COMMIT_SHA ?? 'unknown',
    });
  });

  // Meta webhook callbacks — from Meta's servers, authenticated via HMAC-SHA256
  // signed_request, NOT via X-Service-Auth. Must be before verifyServiceAuth.
  app.use('/api/connectors/meta', express.urlencoded({ extended: false }), metaWebhookRouter);

  // Slack Events API webhook — from Slack's servers, authenticated via the
  // Slack signing secret (HMAC-SHA256 of "v0:{ts}:{body}"). Must be before
  // verifyServiceAuth, and uses express.raw() so the router has the raw
  // bytes needed for HMAC verification.
  app.use(
    '/api/connectors/slack/events',
    express.raw({ type: 'application/json', limit: '1mb' }),
    slackEventsRouter,
  );

  // GitHub App lifecycle webhooks — from GitHub's servers, authenticated via
  // X-Hub-Signature-256 (HMAC-SHA256 over the raw body), NOT via X-Service-Auth.
  // Must be before verifyServiceAuth, and uses express.raw() because a
  // re-serialized body produces a different digest.
  //
  // Unlike the Meta and Slack webhooks this one is load-bearing rather than
  // supplementary: when a non-owner requests the App, `installation.created` is
  // the ONLY signal that an owner ever approved it.
  app.use(
    '/api/connectors/github',
    express.raw({ type: 'application/json', limit: '1mb' }),
    githubWebhookRouter,
  );

  // Stripe Connect webhooks — from Stripe's servers, authenticated via
  // Stripe-Signature (HMAC-SHA256 over `${timestamp}.${rawBody}`, which is NOT
  // the GitHub scheme). Must be before verifyServiceAuth, and uses express.raw()
  // because Stripe signs the exact bytes it sent.
  //
  // Load-bearing rather than supplementary: Stripe exposes no modified-since
  // filter on any list endpoint and its hosted MCP has no events feed, so this
  // is the ONLY route by which an updated invoice or subscription reaches an
  // agent. The poll carries creations and nothing more.
  app.use(
    '/api/connectors/stripe',
    express.raw({ type: 'application/json', limit: '1mb' }),
    stripeWebhookRouter,
  );

  // Everything below requires X-Service-Auth matching CONNECTOR_SERVICE_TOKEN.
  app.use(verifyServiceAuth({ tokenEnvVar: 'CONNECTOR_SERVICE_TOKEN' }));

  // OAuth / API-key / keypair REST routes. Mounted BEFORE the Connect-RPC
  // middleware so Connect handles proto calls untouched. Each subtree gets
  // its own express.json() — we intentionally do NOT enable JSON parsing
  // globally, because the Connect-RPC middleware needs the raw body.
  app.use('/api/connectors/oauth', express.json(), oauthRouter);
  // GitHub App install flow — the org picker's data source and the install
  // start. Service-authed like the rest: these are called by the dashboard
  // through platform-backend, not by GitHub. Only the webhook above is public.
  app.use('/api/connectors/github-app', express.json(), githubAppInstallRouter);
  app.use('/api/connectors/apikey', express.json(), apikeyRouter);
  app.use('/api/connectors/keypair', express.json(), keypairRouter);
  // BigQuery keyless connect (SA-impersonation; plan §3C/§5) — its own subtree
  // because the connect flow (provision SA → grant → verify) fits none of the
  // oauth/apikey/keypair shapes.
  app.use('/api/connectors/bigquery', express.json(), bigqueryRouter);
  // Custom API connections: describe a specification without creating
  // anything, register or reconnect an instance, and serve the per-instance
  // tool schemas the tenant runtime's cache refreshes against. The credential
  // arrives on /register and goes straight to Secret Manager, so the body
  // limit is the ordinary one.
  app.use('/api/connectors/custom-api', express.json(), customApiRouter);
  // Catalog router serves the unified CONNECTORS registry as JSON. Mounted
  // at a more specific prefix than the CRUD router so Express matches it
  // first — the CRUD router handles /api/connectors/* fallback routes.
  app.use('/api/connectors/catalog', express.json(), catalogRouter);
  // The platform's prepaid balances at the aggregators it pays (Locus,
  // Vaaya), for platform-backend's vendor-spend monitor: the keys live here.
  app.use('/api/connectors/platform-vendors', platformVendorBalancesRouter);
  // Cross-tenant lookups for other services (connector → owning tenant, estate
  // health roll-up). Mounted BEFORE the internal execute router, which would
  // otherwise take /internal/* first and fall through to the CRUD router's
  // /:connectorId/* catch-alls.
  app.use('/api/connectors/internal/admin', express.json(), connectorAdminRouter);
  // The x402 wallet's identity (custodian + address), for platform-backend's
  // treasury checks to compare against their own X402_WALLET_ADDRESS.
  app.use('/api/connectors/internal/x402', express.json(), x402WalletRouter);
  // Import placeholders. Mounted alongside the other internal subtrees, before
  // the CRUD router's /:connectorId/* catch-alls.
  app.use('/api/internal/connectors', express.json(), connectorImportRouter);
  // Internal execute endpoint for Cloud Tasks — must be mounted BEFORE the CRUD
  // router so /api/connectors/internal/* is not captured by /:connectorId/* routes.
  app.use('/api/connectors/internal', express.json(), executeRouter);
  // CRUD router mounted LAST at the /api/connectors base so the more
  // specific oauth/apikey/keypair/catalog/internal subtrees win on Express route matching.
  app.use('/api/connectors', express.json(), connectorCrudRouter);

  // Connect-RPC handlers. expressConnectMiddleware parses the request body
  // itself (supports connect+json, connect+proto, gRPC-Web) so we do NOT
  // add express.json() — that would consume the body first and break Connect
  // parsing.
  app.use(
    expressConnectMiddleware({
      routes: (r) => {
        registerConnectorService(r);
      },
      interceptors: [
        // Phase 0t — idempotency on Execute + ExecuteBatch. Header-based
        // tenant/user extraction; HRBP sets X-Liftoff-Tenant-Id and
        // X-Account-Id before calling. Extraction is best-effort — when
        // either is missing the interceptor no-ops and delegates to the
        // inner handler, matching the request-sans-Idempotency-Key path.
        idempotencyInterceptor({
          extractTenant: (ctx) => {
            const headers = (ctx as { requestHeader?: Headers }).requestHeader;
            const tenantId = headers?.get('x-tenant-id') ?? null;
            const userId = headers?.get('x-account-id') ?? null;
            return { tenantId, userId };
          },
        }),
      ],
    }),
  );

  app.use((req, res) => {
    const r = req as Request & { log?: Logger };
    r.log?.warn({}, 'route not found');
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  return app;
}

export async function startServer(opts: ServerOptions): Promise<http.Server> {
  const app = buildApp(opts);
  return new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(opts.port, () => {
      opts.log.info({ port: opts.port }, 'HTTP server listening');
      resolve(server);
    });
    server.on('error', reject);
  });
}

export async function shutdownServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
