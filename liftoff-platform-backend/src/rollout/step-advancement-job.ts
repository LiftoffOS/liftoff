// Rollout Step Advancement Background Job
// Per Section 17: Automatically advance progressive rollouts through their steps

import { rolloutOrchestrationService } from './orchestration-service';
import { logger } from '../infrastructure/logging';

export class RolloutStepAdvancementJob {
  private isRunning = false;
  private intervalHandle: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

  // Start the background job
  start(): void {
    if (this.isRunning) {
      logger.warn('Rollout step advancement job already running');
      return;
    }

    this.isRunning = true;
    this.intervalHandle = setInterval(() => this.runStepAdvancement(), this.CHECK_INTERVAL_MS);

    logger.info('Rollout step advancement job started', {
      intervalMs: this.CHECK_INTERVAL_MS,
    });
  }

  // Stop the background job
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.isRunning = false;
    logger.info('Rollout step advancement job stopped');
  }

  // Run step advancement for all eligible rollouts
  async runStepAdvancement(): Promise<number> {
    try {
      const processed = await rolloutOrchestrationService.processScheduledAdvancements();

      if (processed > 0) {
        logger.info('Processed scheduled rollout advancements', { count: processed });
      }

      return processed;
    } catch (error) {
      logger.error('Error running rollout step advancement', {
        error: (error as Error).message,
      });
      return 0;
    }
  }
}

// Singleton instance
export const rolloutStepAdvancementJob = new RolloutStepAdvancementJob();
