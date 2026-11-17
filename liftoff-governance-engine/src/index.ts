// GovernanceEngine entry point.
// Per Phase 3 of the decomposition plan: this service owns HITL approvals,
// admission decisions (credits / rate limits / kill switches / allowlists),
// the action ledger, the usage ledger, and the audit log. Extracted from
// tenant-runtime's inline governance code + platform-backend's HITL APIs.

import 'dotenv/config';
import {
  initTracing,
  createLogger,
  shutdownTracing,
  withTraceContext,
} from '@liftoffos/telemetry';
import { startServer, shutdownServer } from './server.js';
import { startEntitlementsSubscriber } from './events/entitlements-subscriber.js';
import { startOversightSubscriber } from './events/oversight-subscriber.js';
import { startAgentLifecycleSubscriber } from './events/agent-lifecycle-subscriber.js';
// Side-effect imports — order matters once Phase 3 fills in real handlers:
//   TODO: register admission policy evaluators before any Authorize serves.
//   TODO: register kill-switch invalidation subscribers before Preflight serves.

const SERVICE_NAME = 'liftoff-governance-engine';
const PORT = parseInt(process.env.PORT ?? '8080', 10);

async function main() {
  initTracing({ serviceName: SERVICE_NAME });

  const log = createLogger({
    // 'custom' backend is a zero-dep console logger; governance-engine doesn't
    // have pino as a direct dep so `backend: 'pino'` crashes startup with
    // MODULE_NOT_FOUND at Cloud Run boot. Switch to 'pino' if/when pino is
    // added to dependencies.
    backend: 'custom',
    level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
    cloudTraceProjectId: process.env.GCP_PROJECT_ID,
  });

  log.info({ port: PORT }, 'governance-engine starting');

  const server = await startServer({ port: PORT, log });

  // Start control-plane event subscribers.
  // Fire-and-forget: if Pub/Sub isn't reachable the RPC surface still
  // works, and each subscriber logs its own failure.
  try {
    startEntitlementsSubscriber();
  } catch (err) {
    log.error(
      { error: (err as Error).message },
      'failed to start entitlements subscriber (non-fatal)',
    );
  }

  try {
    startOversightSubscriber();
  } catch (err) {
    log.error(
      { error: (err as Error).message },
      'failed to start oversight subscriber (non-fatal)',
    );
  }

  try {
    startAgentLifecycleSubscriber();
  } catch (err) {
    log.error(
      { error: (err as Error).message },
      'failed to start agent lifecycle subscriber (non-fatal)',
    );
  }

  // Graceful shutdown: drain the HTTP server, flush tracing.
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal received');
    try {
      await shutdownServer(server);
      await shutdownTracing();
    } catch (err) {
      log.error(
        { error: (err as Error).message },
        'error during shutdown',
      );
      process.exit(1);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  // Re-establish trace context for the long-lived server process.
  withTraceContext({}, () => {
    log.info({ port: PORT }, 'governance-engine ready');
  });
}

void main().catch((err) => {
  console.error('fatal: governance-engine failed to start', err);
  process.exit(1);
});
