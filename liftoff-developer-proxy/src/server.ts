import Fastify from 'fastify';
import corsPlugin from '@fastify/cors';
import { loadConfig } from './infrastructure/config.js';
import { closePool } from './infrastructure/database.js';
import { installSigtermHandler } from '@liftoffos/service-runtime';
import { registerProxyRoutes } from './proxy/routes.js';
import { registerCredentialRoutes } from './credentials/routes.js';
import { registerRpcRoutes } from './rpc/router.js';
import { drainOutboxes } from './outbox/worker.js';
import { settleInFlight } from './infrastructure/in-flight.js';
import { registerUsageRoutes } from './usage/routes.js';

export async function buildApp() {
  // Redact both proxy-credential forms from request logs: neither
  // x-api-key nor Authorization may appear in logs, traces, or errors.
  const app = Fastify({
    logger: {
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'headers.authorization',
          'headers["x-api-key"]',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: true,
  });
  const config = loadConfig();

  // CORS — allow browser origins configured via CORS_ALLOWED_ORIGINS (comma-separated)
  const allowedOrigins = config.CORS_ALLOWED_ORIGINS
    ? config.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  await app.register(corsPlugin, {
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  // Connectivity probe. Claude Code sends `HEAD /` against its base URL at
  // startup to confirm the endpoint is reachable; answer 200 so it doesn't
  // log a spurious failure. Unauthenticated — carries no request body.
  app.head('/', async (_req, reply) => reply.code(200).send());

  // Credential management REST API (called directly from the browser with Firebase JWT)
  await registerCredentialRoutes(app);

  // Transparent proxy hot-path: POST /v1/messages, /v1/messages/count_tokens, /v1/revoke
  await registerProxyRoutes(app);

  // Connect-RPC (ByokService management RPCs)
  registerRpcRoutes(app);

  // Internal usage ingestion feeds v1+v2 (platform-backend cost attribution poller)
  await registerUsageRoutes(app);

  return app;
}

export async function start(): Promise<void> {
  const app = await buildApp();
  const config = loadConfig();

  // No background loops: on request-based CPU nothing runs between requests.
  // The outbox is delivered by the hourly ingestion-feed request
  // (usage/routes.ts); shutdown settles what is left, in this order, before
  // the pool closes. Cloud Run allocates CPU for the SIGTERM grace period.
  installSigtermHandler({
    gracePeriodMs: 30_000,
    drainFns: [
      () => settleInFlight(),
      () => drainOutboxes(),
      () => closePool(),
    ],
    inflightCountFn: () => (app.server as { connections?: number }).connections ?? 0,
    logger: {
      info: (m, meta) => app.log.info({ ...meta }, m),
      warn: (m, meta) => app.log.warn({ ...meta }, m),
      error: (m, meta) => app.log.error({ ...meta }, m),
    },
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info({ port: config.PORT }, 'liftoff-developer-proxy listening');
}
