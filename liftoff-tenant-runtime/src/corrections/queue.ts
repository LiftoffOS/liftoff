// Correction Execution Queue
// Per implementation plan: Rate-limited execution queue for corrections

import { CloudTasksClient } from '@google-cloud/tasks';
import { logger } from '../infrastructure/logging';
import { CorrectionQueueItem } from './types';
import { getManagedSecret } from '../infrastructure/secret-store';

const tasksClient = new CloudTasksClient();
const PROJECT_ID = process.env.GCP_PROJECT_ID || 'YOUR_TENANT_PROJECT';
const REGION = process.env.GCP_REGION || 'us-west1';
const QUEUE_NAME = `correction-execution-queue-${process.env.ENVIRONMENT || 'dev'}`;
const SERVICE_URL = process.env.CORRECTION_SERVICE_URL || '';

/**
 * Enqueue a correction for rate-limited execution
 */
export async function enqueueCorrection(item: Omit<CorrectionQueueItem, 'id' | 'createdAt'>): Promise<string> {
  const parent = tasksClient.queuePath(PROJECT_ID, REGION, QUEUE_NAME);

  const task = {
    httpRequest: {
      httpMethod: 'POST' as const,
      url: `${SERVICE_URL}/api/corrections/execute`,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Auth': getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN') || '',
      },
      body: Buffer.from(JSON.stringify({
        tenantId: item.tenantId,
        correctionRequestId: item.correctionRequestId,
        correctionToolName: item.correctionToolName,
        args: item.args,
        retryCount: item.retryCount,
        maxRetries: item.maxRetries,
      })).toString('base64'),
    },
    scheduleTime: {
      seconds: Math.floor(item.executeAfter.getTime() / 1000),
    },
  };

  try {
    const [response] = await tasksClient.createTask({ parent, task });
    const taskId = response.name?.split('/').pop() || '';

    logger.info('Correction enqueued for rate-limited execution', {
      taskId,
      tenantId: item.tenantId,
      correctionRequestId: item.correctionRequestId,
      executeAfter: item.executeAfter,
    });

    return taskId;
  } catch (error) {
    logger.error('Failed to enqueue correction', {
      tenantId: item.tenantId,
      correctionRequestId: item.correctionRequestId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get pending corrections in queue
 */
export async function getPendingCorrections(_tenantId?: string): Promise<number> {
  try {
    const parent = tasksClient.queuePath(PROJECT_ID, REGION, QUEUE_NAME);
    const [queue] = await tasksClient.getQueue({ name: parent });

    // Note: This returns approximate count, not filtered by tenant
    // For per-tenant counts, we'd need to list tasks and filter
    return queue.state === 'RUNNING' ? 1 : 0;
  } catch (error) {
    logger.error('Failed to get pending corrections count', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Purge queue (admin only - for emergency use)
 */
export async function purgeQueue(): Promise<void> {
  const parent = tasksClient.queuePath(PROJECT_ID, REGION, QUEUE_NAME);

  try {
    await tasksClient.purgeQueue({ name: parent });
    logger.warn('Correction queue purged');
  } catch (error) {
    logger.error('Failed to purge correction queue', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Pause queue (for maintenance)
 */
export async function pauseQueue(): Promise<void> {
  const parent = tasksClient.queuePath(PROJECT_ID, REGION, QUEUE_NAME);

  try {
    await tasksClient.pauseQueue({ name: parent });
    logger.info('Correction queue paused');
  } catch (error) {
    logger.error('Failed to pause correction queue', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Resume queue
 */
export async function resumeQueue(): Promise<void> {
  const parent = tasksClient.queuePath(PROJECT_ID, REGION, QUEUE_NAME);

  try {
    await tasksClient.resumeQueue({ name: parent });
    logger.info('Correction queue resumed');
  } catch (error) {
    logger.error('Failed to resume correction queue', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
