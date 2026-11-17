// ConnectorService entry point.
// Per Phase 1 of the decomposition plan: this service owns OAuth flows,
// credential storage, 50+ connector clients, MCP sidecars, and the
// capability → connector-type registry.

import 'dotenv/config';
import {
  initTracing,
  createLogger,
  shutdownTracing,
  withTraceContext,
} from '@liftoffos/telemetry';
import { startServer, shutdownServer } from './server.js';
import { startPollingScheduler } from './polling/scheduler.js';
import { startCredentialTokenKeepalive, stopCredentialTokenKeepalive } from './credentials/token-keepalive.js';
import { startWarehouseReachabilityProbe, stopWarehouseReachabilityProbe } from './credentials/warehouse-reachability-probe.js';
import { backfillExternalAccountIds } from './oauth/backfill-account-ids.js';
import { startComposioReconciler } from './oauth/composio-reconciler.js';
import { startCustomApiSpecDriftSweep, stopCustomApiSpecDriftSweep } from './custom-api/spec-drift-sweep.js';
// Side-effect imports — order matters:
//   1. OAuth refresh handlers must register before any credential fetch
//      runs (prevents `reconnect_required` on expiring tokens).
//   2. Connector clients must register before any Execute/ExecuteBatch
//      RPC is served (otherwise dispatch returns UNIMPLEMENTED).
import './credentials/oauth-providers/index.js';
import './clients/index.js';

const SERVICE_NAME = 'liftoff-connector-service';
const PORT = parseInt(process.env.PORT ?? '8080', 10);

async function main() {
  initTracing({ serviceName: SERVICE_NAME });

  const log = createLogger({
    // 'custom' backend is a zero-dep console logger; connector-service doesn't
    // have pino as a direct dep so `backend: 'pino'` crashes startup with
    // MODULE_NOT_FOUND at Cloud Run boot. Switch to 'pino' if/when pino is
    // added to dependencies.
    backend: 'custom',
    level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
    cloudTraceProjectId: process.env.GCP_PROJECT_ID,
  });

  log.info({ port: PORT }, 'connector-service starting');

  const server = await startServer({ port: PORT, log });

  // Start polling scheduler — polls all active connectors every minute.
  const pollingHandle = startPollingScheduler();

  // Start the OAuth token keepalive — proactively rotates dormant direct-OAuth
  // tokens so they never age out (excludes slack / composio / api_key).
  await startCredentialTokenKeepalive();

  // Start the warehouse reachability probe (plan §4) — warehouses push no
  // revocation event, so a scheduled cheap read detects dead grants and flips
  // status='error' ("Needs Reconnect"). Native warehouse types only.
  await startWarehouseReachabilityProbe();

  // Recover Composio connects whose browser redirect never came back. Without
  // this the connector row is only ever written by GET /callback, so a redirect
  // failure loses the connection silently while Composio keeps (and bills) it.
  const composioReconcilerHandle = startComposioReconciler();

  // Notice when a provider's OpenAPI specification moves. A provider announces
  // nothing and the key keeps working while its API changes, so a custom API
  // connection goes on reporting itself healthy with tools that call a place
  // that is not there. Detects only; applying a change is a person's call.
  startCustomApiSpecDriftSweep();

  // Graceful shutdown: drain the HTTP server, flush tracing.
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal received');
    clearInterval(pollingHandle);
    clearInterval(composioReconcilerHandle);
    await stopCustomApiSpecDriftSweep();
    try {
      await stopCredentialTokenKeepalive();
      await stopWarehouseReachabilityProbe();
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
    log.info({ port: PORT }, 'connector-service ready');
  });

  // One-shot, idempotent backfill: walk every existing connector row missing
  // config.externalAccountId, fetch identity from stored credentials, and
  // write it. Runs AFTER the server reports ready so it never delays
  // readiness; subsequent boots no-op because already-backfilled rows are
  // excluded from the scan. Skippable via env for opt-out.
  if (process.env.BACKFILL_EXTERNAL_ACCOUNT_IDS !== 'false') {
    void backfillExternalAccountIds().catch((err) =>
      log.error(
        { error: (err as Error).message },
        'backfill: top-level error (absorbed)',
      ),
    );
  }
}

void main().catch((err) => {
  console.error('fatal: connector-service failed to start', err);
  process.exit(1);
});
