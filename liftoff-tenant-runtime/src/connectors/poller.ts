// Connector Poller
// Per Section 12: Poller runs on Cloud Run for connectors that don't support webhooks

import type { Connector } from '@liftoffos/connector-types';
import { ConnectorRepository } from './repository';
import { ConnectorService } from './service';
import { logger } from '../infrastructure/logging';

export interface PollerConfig {
  // Default poll interval in milliseconds
  defaultIntervalMs: number;
  // Minimum interval to prevent excessive polling
  minIntervalMs: number;
  // Maximum interval for backoff
  maxIntervalMs: number;
  // Backoff multiplier on failure
  backoffMultiplier: number;
  // Rate limit: max polls per minute per connector
  maxPollsPerMinute: number;
  // Concurrent poll limit
  maxConcurrentPolls: number;
}

export interface PollResult {
  connectorId: string;
  success: boolean;
  recordsProcessed: number;
  error?: string;
  duration: number;
  nextPollAt: Date;
}

interface PollerState {
  connectorId: string;
  currentIntervalMs: number;
  consecutiveFailures: number;
  lastPollAt: Date | null;
  lastPollResult: 'success' | 'failure' | null;
  pollCount: number;
  windowStart: Date;
}

// Default configuration following best practices
const DEFAULT_CONFIG: PollerConfig = {
  defaultIntervalMs: 60000, // 1 minute
  minIntervalMs: 10000, // 10 seconds minimum
  maxIntervalMs: 3600000, // 1 hour maximum
  backoffMultiplier: 2,
  maxPollsPerMinute: 10,
  maxConcurrentPolls: 5,
};

export class Poller {
  private config: PollerConfig;
  private repository: ConnectorRepository;
  private connectorService: ConnectorService;
  private states: Map<string, PollerState> = new Map();
  private activePolls: Set<string> = new Set();
  private pollTimers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;

  constructor(
    connectorService: ConnectorService,
    config: Partial<PollerConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.repository = new ConnectorRepository();
    this.connectorService = connectorService;
  }

  // Start polling for a specific connector
  async startPolling(connector: Connector): Promise<void> {
    if (this.pollTimers.has(connector.id)) {
      logger.warn({ message: 'Poller already running for connector', connectorId: connector.id });
      return;
    }

    logger.info({
      message: 'Starting poller for connector',
      connectorId: connector.id,
      connectorType: connector.type,
      tenantId: connector.tenantId,
    });

    // Initialize state
    const intervalMs = this.getConfiguredInterval(connector);
    this.states.set(connector.id, {
      connectorId: connector.id,
      currentIntervalMs: intervalMs,
      consecutiveFailures: 0,
      lastPollAt: null,
      lastPollResult: null,
      pollCount: 0,
      windowStart: new Date(),
    });

    // Schedule first poll
    this.schedulePoll(connector);
    this.isRunning = true;
  }

  // Stop polling for a specific connector
  stopPolling(connectorId: string): void {
    const timer = this.pollTimers.get(connectorId);
    if (timer) {
      clearTimeout(timer);
      this.pollTimers.delete(connectorId);
      logger.info({ message: 'Stopped poller for connector', connectorId });
    }
    this.states.delete(connectorId);
    this.activePolls.delete(connectorId);
  }

  // Stop all polling
  stopAll(): void {
    for (const [connectorId, timer] of this.pollTimers) {
      clearTimeout(timer);
      logger.info({ message: 'Stopped poller for connector', connectorId });
    }
    this.pollTimers.clear();
    this.states.clear();
    this.activePolls.clear();
    this.isRunning = false;
  }

  // Get current poller state for a connector
  getState(connectorId: string): PollerState | undefined {
    return this.states.get(connectorId);
  }

  // Manually trigger a poll (bypasses rate limiting)
  async triggerPoll(connector: Connector): Promise<PollResult> {
    return this.executePoll(connector, true);
  }

  private schedulePoll(connector: Connector): void {
    const state = this.states.get(connector.id);
    if (!state) return;

    const timer = setTimeout(async () => {
      await this.executePoll(connector);

      // Reschedule if still running
      if (this.states.has(connector.id)) {
        this.schedulePoll(connector);
      }
    }, state.currentIntervalMs);

    this.pollTimers.set(connector.id, timer);
  }

  private async executePoll(
    connector: Connector,
    bypassRateLimit: boolean = false
  ): Promise<PollResult> {
    const state = this.states.get(connector.id);
    const startTime = Date.now();

    // Check concurrent poll limit
    if (this.activePolls.size >= this.config.maxConcurrentPolls) {
      logger.warn({
        message: 'Concurrent poll limit reached',
        connectorId: connector.id,
        activePolls: this.activePolls.size,
        limit: this.config.maxConcurrentPolls,
      });

      return {
        connectorId: connector.id,
        success: false,
        recordsProcessed: 0,
        error: 'Concurrent poll limit reached',
        duration: 0,
        nextPollAt: new Date(Date.now() + (state?.currentIntervalMs || this.config.defaultIntervalMs)),
      };
    }

    // Check rate limit
    if (!bypassRateLimit && state && !this.checkRateLimit(state)) {
      logger.warn({
        message: 'Rate limit exceeded for connector',
        connectorId: connector.id,
        pollCount: state.pollCount,
        maxPollsPerMinute: this.config.maxPollsPerMinute,
      });

      return {
        connectorId: connector.id,
        success: false,
        recordsProcessed: 0,
        error: 'Rate limit exceeded',
        duration: 0,
        nextPollAt: new Date(Date.now() + state.currentIntervalMs),
      };
    }

    this.activePolls.add(connector.id);

    try {
      logger.info({
        message: 'Executing poll for connector',
        connectorId: connector.id,
        connectorType: connector.type,
        attempt: state ? state.consecutiveFailures + 1 : 1,
      });

      // Execute the actual sync
      const recordsProcessed = await this.performSync(connector);

      const duration = Date.now() - startTime;

      // Update state on success
      if (state) {
        state.consecutiveFailures = 0;
        state.currentIntervalMs = this.getConfiguredInterval(connector);
        state.lastPollAt = new Date();
        state.lastPollResult = 'success';
        state.pollCount++;
      }

      logger.info({
        message: 'Poll completed successfully',
        connectorId: connector.id,
        recordsProcessed,
        duration,
      });

      // Update sync stats in the connector service
      await this.connectorService.updateSyncStats(connector.id, {
        lastSyncAt: new Date(),
        itemsSynced: recordsProcessed,
        syncDuration: duration,
        errors: 0,
      });

      return {
        connectorId: connector.id,
        success: true,
        recordsProcessed,
        duration,
        nextPollAt: new Date(Date.now() + (state?.currentIntervalMs || this.config.defaultIntervalMs)),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = (error as Error).message;

      // Update state on failure with backoff
      if (state) {
        state.consecutiveFailures++;
        state.currentIntervalMs = this.calculateBackoff(state);
        state.lastPollAt = new Date();
        state.lastPollResult = 'failure';
        state.pollCount++;
      }

      logger.error({
        message: 'Poll failed',
        connectorId: connector.id,
        error: errorMessage,
        consecutiveFailures: state?.consecutiveFailures,
        nextIntervalMs: state?.currentIntervalMs,
        duration,
      });

      // Update sync stats with error
      await this.connectorService.updateSyncStats(connector.id, {
        lastSyncAt: new Date(),
        itemsSynced: 0,
        syncDuration: duration,
        errors: 1,
        lastError: errorMessage,
      });

      return {
        connectorId: connector.id,
        success: false,
        recordsProcessed: 0,
        error: errorMessage,
        duration,
        nextPollAt: new Date(Date.now() + (state?.currentIntervalMs || this.config.defaultIntervalMs)),
      };
    } finally {
      this.activePolls.delete(connector.id);
    }
  }

  private async performSync(connector: Connector): Promise<number> {
    // The actual sync is triggered via the connector service
    // This uses the existing triggerSync infrastructure
    await this.connectorService.triggerSync(connector.id);

    // Return a placeholder - actual record count comes from the sync callback
    // In a real implementation, this would wait for the sync to complete
    // and return the actual count
    return 0;
  }

  private checkRateLimit(state: PollerState): boolean {
    const now = new Date();
    const windowMs = 60000; // 1 minute window

    // Reset window if expired
    if (now.getTime() - state.windowStart.getTime() > windowMs) {
      state.pollCount = 0;
      state.windowStart = now;
    }

    return state.pollCount < this.config.maxPollsPerMinute;
  }

  private calculateBackoff(state: PollerState): number {
    // Exponential backoff with jitter
    const baseBackoff = state.currentIntervalMs * this.config.backoffMultiplier;
    const jitter = Math.random() * 0.1 * baseBackoff; // 10% jitter
    const backoffWithJitter = baseBackoff + jitter;

    // Clamp to min/max
    return Math.min(
      Math.max(backoffWithJitter, this.config.minIntervalMs),
      this.config.maxIntervalMs
    );
  }

  private getConfiguredInterval(connector: Connector): number {
    // Check for connector-specific interval in config
    const configuredInterval = connector.config?.pollIntervalMs;
    if (typeof configuredInterval === 'number' && configuredInterval > 0) {
      return Math.max(configuredInterval, this.config.minIntervalMs);
    }
    return this.config.defaultIntervalMs;
  }

  // Get all active poll states for monitoring
  getActiveStates(): PollerState[] {
    return Array.from(this.states.values());
  }

  // Check if poller is running
  isActive(): boolean {
    return this.isRunning && this.pollTimers.size > 0;
  }

  // Update configuration at runtime
  updateConfig(newConfig: Partial<PollerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info({ message: 'Poller config updated', config: this.config });
  }
}

// Factory function for creating a poller with custom config
export function createPoller(
  connectorService: ConnectorService,
  config?: Partial<PollerConfig>
): Poller {
  return new Poller(connectorService, config);
}
