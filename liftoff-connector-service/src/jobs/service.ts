import { withTenantScope, withAdminScope } from '../db/pool.js';
import { logger } from '../infra/logging.js';

export type JobStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface ConnectorJob {
  id: string;
  tenantId: string;
  connectorId: string | null;
  operation: string;
  input: Record<string, unknown>;
  status: JobStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

function rowToJob(row: Record<string, unknown>): ConnectorJob {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    connectorId: (row.connector_id as string | null) ?? null,
    operation: row.operation as string,
    input: (row.input as Record<string, unknown>) ?? {},
    status: row.status as JobStatus,
    result: (row.result as Record<string, unknown> | null) ?? null,
    error: (row.error as string | null) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    expiresAt: row.expires_at as Date,
  };
}

export async function createJob(params: {
  tenantId: string;
  connectorId: string | null;
  operation: string;
  input: Record<string, unknown>;
}): Promise<string> {
  const { tenantId, connectorId, operation, input } = params;
  const result = await withAdminScope(
    { caller: 'jobs/service.createJob', reason: 'Insert new async job row before enqueue' },
    async (client) => {
      return client.query<{ id: string }>(
        `INSERT INTO connector_jobs (tenant_id, connector_id, operation, input)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [tenantId, connectorId, operation, JSON.stringify(input)],
      );
    },
  );
  const jobId = result.rows[0].id;

  // Enqueue the Cloud Task. On failure, mark the job failed immediately so it
  // doesn't sit in 'pending' forever — the caller still receives a 500.
  try {
    // Dynamic import breaks the service → queue → execute-router → service cycle.
    const { enqueueJob } = await import('./queue.js');
    await enqueueJob(jobId);
  } catch (err) {
    logger.error({ err, jobId }, 'createJob: enqueue failed — marking job failed');
    await updateJob(jobId, { status: 'failed', error: 'Failed to enqueue job' });
    throw err;
  }

  return jobId;
}

export async function getJob(tenantId: string, jobId: string): Promise<ConnectorJob | null> {
  const result = await withTenantScope(tenantId, async (client) => {
    return client.query<Record<string, unknown>>(
      `SELECT * FROM connector_jobs WHERE id = $1`,
      [jobId],
    );
  });
  if (result.rows.length === 0) return null;
  return rowToJob(result.rows[0]);
}

// Atomically claims the job by transitioning pending → running.
// Returns null if not found or already claimed (prevents double-execution on Cloud Tasks retry).
export async function claimJobForExecution(jobId: string): Promise<ConnectorJob | null> {
  const result = await withAdminScope(
    { caller: 'jobs/service.claimJobForExecution', reason: 'Cloud Tasks execute — claim job atomically' },
    async (client) => {
      return client.query<Record<string, unknown>>(
        `UPDATE connector_jobs
         SET status = 'running', updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [jobId],
      );
    },
  );
  if (result.rows.length === 0) return null;
  return rowToJob(result.rows[0]);
}

export async function updateJob(
  jobId: string,
  update: { status: JobStatus; result?: Record<string, unknown>; error?: string },
): Promise<void> {
  await withAdminScope(
    { caller: 'jobs/service.updateJob', reason: 'Write execute result' },
    async (client) => {
      await client.query(
        `UPDATE connector_jobs
         SET status = $2, result = $3, error = $4, updated_at = NOW()
         WHERE id = $1`,
        [jobId, update.status, update.result ? JSON.stringify(update.result) : null, update.error ?? null],
      );
    },
  );
}
