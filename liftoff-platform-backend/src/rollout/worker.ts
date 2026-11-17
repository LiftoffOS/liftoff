// Rollout Worker
// Per Section 17: Background job for progressive rollout advancement

import { rolloutOrchestrationService } from './orchestration-service';
import { logger } from '../infrastructure/logging';

const POLL_INTERVAL_MS = 60000; // Check every minute

let isRunning = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

// Process scheduled rollout advancements
async function processRollouts(): Promise<void> {
  if (isRunning) {
    logger.debug('Rollout worker already running, skipping');
    return;
  }

  isRunning = true;

  try {
    const processed = await rolloutOrchestrationService.processScheduledAdvancements();

    if (processed > 0) {
      logger.info('Rollout worker processed advancements', { count: processed });
    }
  } catch (error) {
    logger.error('Rollout worker error', { error });
  } finally {
    isRunning = false;
  }
}

// Start the rollout worker
export function startRolloutWorker(): void {
  if (intervalId) {
    logger.warn('Rollout worker already started');
    return;
  }

  logger.info('Starting rollout worker', { intervalMs: POLL_INTERVAL_MS });

  // Run immediately on start
  processRollouts();

  // Then run on interval
  intervalId = setInterval(processRollouts, POLL_INTERVAL_MS);
}

// Stop the rollout worker
export function stopRolloutWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Stopped rollout worker');
  }
}

// Check if worker is running
export function isRolloutWorkerRunning(): boolean {
  return intervalId !== null;
}
