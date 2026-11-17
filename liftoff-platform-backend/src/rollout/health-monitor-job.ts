// Rollout Health Monitor Background Job
// Per Section 17: Continuous health monitoring for in-progress rollouts

import { rolloutOrchestrationService, RolloutProgress } from './orchestration-service';
import { withAdminScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { RolloutMetrics } from '../model-registry/types';

export interface HealthCheckResult {
  rolloutId: string;
  healthy: boolean;
  metrics: RolloutMetrics;
  thresholdBreaches: string[];
  action: 'none' | 'rollback' | 'pause';
}

export class RolloutHealthMonitorJob {
  private isRunning = false;
  private intervalHandle: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

  // Start the background monitoring job
  start(): void {
    if (this.isRunning) {
      logger.warn('Rollout health monitor already running');
      return;
    }

    this.isRunning = true;
    this.intervalHandle = setInterval(() => this.runHealthChecks(), this.CHECK_INTERVAL_MS);

    logger.info('Rollout health monitor started', {
      intervalMs: this.CHECK_INTERVAL_MS,
    });
  }

  // Stop the background monitoring job
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.isRunning = false;
    logger.info('Rollout health monitor stopped');
  }

  // Run health checks for all in-progress rollouts
  async runHealthChecks(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    try {
      const inProgressRollouts = await this.getInProgressRollouts();

      for (const rollout of inProgressRollouts) {
        try {
          const result = await this.checkRolloutHealth(rollout);
          results.push(result);

          if (!result.healthy) {
            logger.warn('Rollout health check failed', {
              rolloutId: rollout.rolloutId,
              thresholdBreaches: result.thresholdBreaches,
              action: result.action,
            });
          }
        } catch (error) {
          logger.error('Error checking rollout health', {
            rolloutId: rollout.rolloutId,
            error: (error as Error).message,
          });
        }
      }

      if (inProgressRollouts.length > 0) {
        logger.info('Completed rollout health checks', {
          checked: inProgressRollouts.length,
          unhealthy: results.filter(r => !r.healthy).length,
        });
      }
    } catch (error) {
      logger.error('Error running rollout health checks', {
        error: (error as Error).message,
      });
    }

    return results;
  }

  // Get all in-progress rollouts
  private async getInProgressRollouts(): Promise<RolloutProgress[]> {
    const result = await withAdminScope({ caller: 'rollout.health-monitor-job', reason: 'cross-tenant model-rollout health monitor' }, (client) => client.query(
      `SELECT r.id, r.status, r.strategy, r.current_step, r.current_percentage,
              r.next_step_at, r.config, r.metrics
       FROM model_rollouts r
       WHERE r.status = 'in_progress'
         AND r.config->>'healthCheckEnabled' = 'true'`
    ));

    return result.rows.map(row => ({
      rolloutId: row.id,
      status: row.status,
      strategy: row.strategy,
      currentStep: row.current_step || 0,
      totalSteps: this.calculateTotalSteps(row.strategy, row.config),
      currentPercentage: row.current_percentage || 0,
      targetPercentage: 100,
      nextStepAt: row.next_step_at,
      metrics: row.metrics || this.getDefaultMetrics(),
    }));
  }

  // Check health for a single rollout
  private async checkRolloutHealth(progress: RolloutProgress): Promise<HealthCheckResult> {
    // Get fresh metrics from the metrics service
    const metrics = await this.fetchRolloutMetrics(progress.rolloutId);
    const config = await this.getRolloutConfig(progress.rolloutId);

    const thresholdBreaches: string[] = [];

    // Check error rate threshold
    const errorThreshold = config.errorThresholdPercent || 5;
    if (metrics.errorRate * 100 > errorThreshold) {
      thresholdBreaches.push(
        `Error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeds threshold ${errorThreshold}%`
      );
    }

    // Check latency threshold
    const latencyThreshold = config.latencyThresholdMs || 5000;
    if (metrics.p99LatencyMs > latencyThreshold) {
      thresholdBreaches.push(
        `P99 latency ${metrics.p99LatencyMs}ms exceeds threshold ${latencyThreshold}ms`
      );
    }

    // Check sample size is sufficient for meaningful analysis
    const minSampleSize = config.minSampleSize || 100;
    const insufficientSamples = metrics.requestsTotal < minSampleSize;

    let action: HealthCheckResult['action'] = 'none';

    if (thresholdBreaches.length > 0 && !insufficientSamples) {
      // Trigger rollback
      const rollbackReason = `Auto-rollback: ${thresholdBreaches.join('; ')}`;
      await rolloutOrchestrationService.rollbackRollout(progress.rolloutId, rollbackReason);
      action = 'rollback';

      logger.warn('Triggered auto-rollback due to health check failure', {
        rolloutId: progress.rolloutId,
        thresholdBreaches,
        metrics,
      });
    }

    // Update metrics in database
    await this.updateRolloutMetrics(progress.rolloutId, metrics);

    return {
      rolloutId: progress.rolloutId,
      healthy: thresholdBreaches.length === 0,
      metrics,
      thresholdBreaches,
      action,
    };
  }

  // Fetch current metrics for a rollout
  private async fetchRolloutMetrics(rolloutId: string): Promise<RolloutMetrics> {

    // Get metrics from the last observation window (e.g., 5 minutes)
    const result = await withAdminScope({ caller: 'rollout.health-monitor-job', reason: 'cross-tenant model-rollout health monitor' }, (client) => client.query(
      `SELECT
         COUNT(*) as total_requests,
         SUM(CASE WHEN success = false THEN 1 ELSE 0 END) as error_count,
         AVG(latency_ms) as avg_latency,
         PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms) as p99_latency
       FROM rollout_request_metrics
       WHERE rollout_id = $1
         AND created_at > NOW() - INTERVAL '5 minutes'`,
      [rolloutId]
    ));

    const row = result.rows[0];

    if (!row || row.total_requests === 0) {
      return this.getDefaultMetrics();
    }

    return {
      requestsTotal: parseInt(row.total_requests, 10),
      requestsSuccess: parseInt(row.total_requests, 10) - parseInt(row.error_count || '0', 10),
      requestsFailed: parseInt(row.error_count || '0', 10),
      errorRate: row.error_count ? parseInt(row.error_count, 10) / parseInt(row.total_requests, 10) : 0,
      averageLatencyMs: parseFloat(row.avg_latency) || 0,
      p99LatencyMs: parseFloat(row.p99_latency) || 0,
    };
  }

  // Update rollout metrics in database
  private async updateRolloutMetrics(rolloutId: string, metrics: RolloutMetrics): Promise<void> {
    await withAdminScope({ caller: 'rollout.health-monitor-job', reason: 'cross-tenant model-rollout health monitor' }, (client) => client.query(
      `UPDATE model_rollouts SET
         metrics = $2,
         last_health_check_at = NOW(),
         updated_at = NOW()
       WHERE id = $1`,
      [rolloutId, JSON.stringify(metrics)]
    ));
  }

  // Get rollout config
  private async getRolloutConfig(rolloutId: string): Promise<{
    errorThresholdPercent?: number;
    latencyThresholdMs?: number;
    minSampleSize?: number;
    healthCheckEnabled?: boolean;
  }> {
    const result = await withAdminScope({ caller: 'rollout.health-monitor-job', reason: 'cross-tenant model-rollout health monitor' }, (client) => client.query(
      `SELECT config FROM model_rollouts WHERE id = $1`,
      [rolloutId]
    ));

    if (result.rows.length === 0) {
      return {};
    }

    return typeof result.rows[0].config === 'string'
      ? JSON.parse(result.rows[0].config)
      : result.rows[0].config;
  }

  // Calculate total steps based on strategy
  private calculateTotalSteps(strategy: string, config: any): number {
    if (strategy === 'gradual') {
      return (config?.gradualSteps?.length || 4);
    }
    if (strategy === 'canary') {
      return 2; // canary phase + 100%
    }
    return 1; // immediate
  }

  // Default metrics for new/empty rollouts
  private getDefaultMetrics(): RolloutMetrics {
    return {
      requestsTotal: 0,
      requestsSuccess: 0,
      requestsFailed: 0,
      errorRate: 0,
      averageLatencyMs: 0,
      p99LatencyMs: 0,
    };
  }
}

// Singleton instance
export const rolloutHealthMonitorJob = new RolloutHealthMonitorJob();
