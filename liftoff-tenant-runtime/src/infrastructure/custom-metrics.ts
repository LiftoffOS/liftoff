// Custom Metrics Service
// Per Section 16: workflow_stuck custom metric for alerting

import { MetricServiceClient } from '@google-cloud/monitoring';
import { pool } from './database';
import { logger } from './logging';

const metricsClient = new MetricServiceClient();
const projectId = process.env.GCP_PROJECT_ID || '';

// Custom metric types
export const CUSTOM_METRICS = {
  WORKFLOWS_STUCK: 'custom.googleapis.com/liftoff/workflows/stuck_count',
  WORKFLOWS_ACTIVE: 'custom.googleapis.com/liftoff/workflows/active_count',
  TASKS_QUEUED: 'custom.googleapis.com/liftoff/tasks/queued_count',
  ACTIONS_RATE: 'custom.googleapis.com/liftoff/actions/rate_per_minute',
  ESCALATIONS_PENDING: 'custom.googleapis.com/liftoff/escalations/pending_count',
  REFLECTION_BACKLOG: 'custom.googleapis.com/liftoff/reflection/backlog_count',
  // Reactive subscriptions
  REACTIVE_SUBSCRIPTIONS_ACTIVE: 'custom.googleapis.com/liftoff/reactive_subscriptions/active_count',
  REACTIVE_SUBSCRIPTIONS_MATCHED: 'custom.googleapis.com/liftoff/reactive_subscriptions/matched_count',
  REACTIVE_SUBSCRIPTIONS_ERRORED: 'custom.googleapis.com/liftoff/reactive_subscriptions/errored_count',
  REACTIVE_SUBSCRIPTIONS_EVAL_P99: 'custom.googleapis.com/liftoff/reactive_subscriptions/eval_duration_p99_ms',
};

export interface MetricPoint {
  metricType: string;
  value: number;
  labels?: Record<string, string>;
}

export class CustomMetricsService {
  private projectName: string;

  constructor() {
    this.projectName = `projects/${projectId}`;
  }

  // Write a single metric point
  async writeMetric(point: MetricPoint): Promise<void> {
    const now = new Date();

    const timeSeries = {
      metric: {
        type: point.metricType,
        labels: point.labels || {},
      },
      resource: {
        type: 'global',
        labels: {
          project_id: projectId,
        },
      },
      points: [
        {
          interval: {
            endTime: {
              seconds: Math.floor(now.getTime() / 1000),
            },
          },
          value: {
            int64Value: point.value,
          },
        },
      ],
    };

    try {
      await metricsClient.createTimeSeries({
        name: this.projectName,
        timeSeries: [timeSeries],
      });

      logger.debug('Custom metric written', {
        metricType: point.metricType,
        value: point.value,
      });
    } catch (error) {
      logger.error('Failed to write custom metric', {
        metricType: point.metricType,
        error: (error as Error).message,
      });
    }
  }

  // Per Section 16: Check for stuck workflows and emit metric
  async emitStuckWorkflowsMetric(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count
       FROM workflows
       WHERE status = 'running'
         AND updated_at < NOW() - INTERVAL '1 hour'`
    );

    const stuckCount = parseInt(result.rows[0].count);

    await this.writeMetric({
      metricType: CUSTOM_METRICS.WORKFLOWS_STUCK,
      value: stuckCount,
      labels: {
        threshold: '1_hour',
      },
    });

    if (stuckCount > 0) {
      logger.warn('Stuck workflows detected', {
        count: stuckCount,
      });
    }

    return stuckCount;
  }

  // Emit active workflows count
  async emitActiveWorkflowsMetric(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count
       FROM workflows
       WHERE status IN ('pending', 'running')`
    );

    const count = parseInt(result.rows[0].count);

    await this.writeMetric({
      metricType: CUSTOM_METRICS.WORKFLOWS_ACTIVE,
      value: count,
    });

    return count;
  }

  // Emit queued tasks count
  async emitQueuedTasksMetric(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count
       FROM workflow_tasks
       WHERE status IN ('pending', 'queued')`
    );

    const count = parseInt(result.rows[0].count);

    await this.writeMetric({
      metricType: CUSTOM_METRICS.TASKS_QUEUED,
      value: count,
    });

    return count;
  }

  // Emit actions rate (per minute)
  async emitActionsRateMetric(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count
       FROM actions
       WHERE created_at > NOW() - INTERVAL '1 minute'`
    );

    const rate = parseInt(result.rows[0].count);

    await this.writeMetric({
      metricType: CUSTOM_METRICS.ACTIONS_RATE,
      value: rate,
    });

    return rate;
  }

  // Emit pending escalations count
  async emitPendingEscalationsMetric(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count
       FROM workflow_escalations
       WHERE status = 'pending'`
    );

    const count = parseInt(result.rows[0].count);

    await this.writeMetric({
      metricType: CUSTOM_METRICS.ESCALATIONS_PENDING,
      value: count,
    });

    return count;
  }

  // Emit reflection backlog
  async emitReflectionBacklogMetric(): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count
       FROM reflection_suggestions
       WHERE status = 'pending'`
    );

    const count = parseInt(result.rows[0].count);

    await this.writeMetric({
      metricType: CUSTOM_METRICS.REFLECTION_BACKLOG,
      value: count,
    });

    return count;
  }

  // Emit all metrics at once (called by Cloud Scheduler every minute)
  async emitAllMetrics(): Promise<{
    stuckWorkflows: number;
    activeWorkflows: number;
    queuedTasks: number;
    actionsRate: number;
    pendingEscalations: number;
    reflectionBacklog: number;
  }> {
    const [
      stuckWorkflows,
      activeWorkflows,
      queuedTasks,
      actionsRate,
      pendingEscalations,
      reflectionBacklog,
    ] = await Promise.all([
      this.emitStuckWorkflowsMetric(),
      this.emitActiveWorkflowsMetric(),
      this.emitQueuedTasksMetric(),
      this.emitActionsRateMetric(),
      this.emitPendingEscalationsMetric(),
      this.emitReflectionBacklogMetric(),
    ]);

    logger.info('All custom metrics emitted', {
      stuckWorkflows,
      activeWorkflows,
      queuedTasks,
      actionsRate,
      pendingEscalations,
      reflectionBacklog,
    });

    return {
      stuckWorkflows,
      activeWorkflows,
      queuedTasks,
      actionsRate,
      pendingEscalations,
      reflectionBacklog,
    };
  }
}

export const customMetricsService = new CustomMetricsService();
