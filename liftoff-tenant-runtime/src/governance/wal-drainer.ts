// Governance WAL drainer — background loop.
//
// Runs every 5s, draining unreplicated governance_wal rows to the
// governance-engine Record RPC. Started from src/index.ts when
// GOVERNANCE_SERVICE_ENABLED !== 'off'.
//
// Idempotent on retry (Record is keyed by idempotency_key server-side).
// Best-effort: any error is logged and the loop continues so a drain
// failure cannot cascade into service-wide unhealth.

import { getGovernanceServiceClient } from './governance-service-client';
import { drainWal } from './wal';
import { logger } from '../infrastructure/logging';

const DRAIN_INTERVAL_MS = 5_000;
const DRAIN_BATCH_SIZE = 50;

let running = false;
let timer: NodeJS.Timeout | null = null;

async function runOnce(): Promise<void> {
  try {
    const client = getGovernanceServiceClient();
    const result = await drainWal(client, DRAIN_BATCH_SIZE);
    if (result.attempted > 0) {
      logger.info(
        {
          event: 'governance_wal_drain',
          attempted: result.attempted,
          succeeded: result.succeeded,
          failed: result.failed,
        },
        'governance_wal drain pass complete',
      );
    }
  } catch (err) {
    // Swallow. Log and let the next tick retry.
    logger.warn(
      {
        event: 'governance_wal_drain_failed',
        error: (err as Error).message,
      },
      'governance_wal drain pass failed (will retry)',
    );
  }
}

export function startWalDrainer(): void {
  if (running) return;
  running = true;
  logger.info(
    { event: 'governance_wal_drainer_started', intervalMs: DRAIN_INTERVAL_MS },
    'governance WAL drainer started',
  );
  const schedule = (): void => {
    timer = setTimeout(async () => {
      await runOnce();
      if (running) schedule();
    }, DRAIN_INTERVAL_MS);
  };
  schedule();
}

export function stopWalDrainer(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
