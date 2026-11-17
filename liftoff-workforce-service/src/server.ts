// Fastify server bootstrap for liftoff-workforce-service.
//
// Mount order:
//   1. /health + /ready routes — readiness flag driven by
//      @liftoffos/service-runtime.installSigtermHandler.
//   2. Workforce plan REST routes.
//   3. Chat routes (non-streaming).
//   4. Chat stream routes (SSE).
//   5. Stuck-plan resumer background task.

import Fastify, { type FastifyInstance } from 'fastify';
import {
  installSigtermHandler,
  createReadinessRoutes,
} from '@liftoffos/service-runtime';
import { initTracing, shutdownTracing } from '@liftoffos/telemetry';
import { loadConfig } from './infrastructure/config.js';
import { initPool, closePool } from './infrastructure/database.js';
import { registerWorkforcePlanRoutes } from './workforce-plans/router.js';
import { registerChatRoutes } from './workforce-plans/chat-router.js';
import { registerChatStreamRoutes } from './workforce-plans/chat-stream-router.js';
import { registerPresenceRoutes } from './workforce-plans/presence-router.js';
import { registerFileCardRoutes } from './workforce-plans/file-card-router.js';
import { startStuckPlanResumer } from './workforce-plans/stuck-plan-resumer.js';
import { startOutboxWorker, stopOutboxWorker } from './events/outbox-worker.js';
import { startKillSwitchSubscriber } from './workforce-plans/kill-switch-subscriber.js';
import { registerPendingIntegrationRoutes } from './workforce-plans/pending-integration-resolver.js';
import { registerHrbpTaskRoutes } from './workforce-plans/hrbp-task-handler.js';
import { registerChatContinuationTaskRoutes } from './workforce-plans/chat-continuation-task-handler.js';
import { registerWorkforcePlanTools } from './workforce-plans/tools/index.js';
import {
  getRemoteWorkspaceActionsStatus,
  registerRemoteWorkspaceActions,
} from './workforce-plans/tools/remote-workspace-actions.js';

export async function buildApp(): Promise<FastifyInstance> {
  const config = loadConfig();

  // Initialise the DB pool early so startup fails fast on misconfiguration.
  await initPool();

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

  // Step 1 — Readiness + SIGTERM drain.
  // Initialise distributed tracing (no-op outside GCP).
  initTracing({ serviceName: 'liftoff-workforce-service' });

  // Start background workers before accepting traffic.
  const outboxHandle = startOutboxWorker();
  startKillSwitchSubscriber();

  const controls = installSigtermHandler({
    gracePeriodMs: 30_000,
    drainFns: [
      () => { stopOutboxWorker(outboxHandle); return closePool(); },
      () => shutdownTracing(),
    ],
    inflightCountFn: () => app.server.connections ?? 0,
    logger: {
      info: (m, meta) => app.log.info({ ...meta }, m),
      warn: (m, meta) => app.log.warn({ ...meta }, m),
      error: (m, meta) => app.log.error({ ...meta }, m),
    },
  });
  const routes = createReadinessRoutes(controls);
  // /health carries the workspace-action registration outcome so an
  // unreachable platform-backend at startup is visible, not silent.
  app.get('/health', (_req, reply) => {
    const { status, lastSuccessAt, lastError } = getRemoteWorkspaceActionsStatus();
    return reply.code(200).send({ status: 'ok', workspaceActions: { status, lastSuccessAt, lastError } });
  });
  app.get('/ready', (_req, reply) => routes.ready(_req, reply));

  // Step 1a — Populate the CAIO tool registry. The accessors in
  // workforce-plans/tools register lazily too, so this is belt-and-braces:
  // it surfaces a malformed tool definition at startup instead of on
  // somebody's first chat turn.
  registerWorkforcePlanTools();

  // Step 1b — The workspace actions platform-backend serves, registered as
  // the CAIO's own tools. The first attempt is awaited so a healthy backend
  // registers them before the server listens; the retries run behind it and
  // the five-minute refresh takes over. The process starts either way; the
  // outcome is on /health.
  await registerRemoteWorkspaceActions();

  // Step 2 — Workforce plan REST routes.
  await registerWorkforcePlanRoutes(app);

  // Step 3 — CAIO chat routes (non-streaming).
  await registerChatRoutes(app);

  // Step 4 — CAIO chat stream routes (SSE).
  await registerChatStreamRoutes(app);

  // Step 4a — CAIO chat multiplayer: presence + turn-event following.
  await registerPresenceRoutes(app);
  await registerFileCardRoutes(app);

  // Step 5 — OAuth callback for pending integrations.
  await registerPendingIntegrationRoutes(app);

  // Step 5a — Cloud Tasks delivery: HRBP per-spec fan-out.
  await registerHrbpTaskRoutes(app);

  // Step 5b — Cloud Tasks delivery: a Chief AI Officer turn's continuation.
  await registerChatContinuationTaskRoutes(app);

  // Step 6 — Background task: resume stuck plans.
  startStuckPlanResumer();

  return app;
}

export async function start(): Promise<void> {
  const app = await buildApp();
  const config = loadConfig();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info({ port: config.PORT }, 'liftoff-workforce-service listening');
}
