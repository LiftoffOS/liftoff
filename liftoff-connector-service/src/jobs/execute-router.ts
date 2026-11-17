import { Router } from 'express';
import { claimJobForExecution, updateJob } from './service.js';
import { handleCreateFromTemplate, handleCopyAndReplace } from './handlers/presentations.js';
import { handleCreateGoogleDoc, handleCopyAndEditDocument } from './handlers/documents.js';
import { isReconnectRequiredOAuthError } from '../credentials/service.js';
import { logger } from '../infra/logging.js';
import type { ConnectorJob } from './service.js';
import type { CreateFromTemplateBody } from './handlers/presentations.js';
import type { CreateGoogleDocBody } from './handlers/documents.js';

export const executeRouter = Router();

async function runJobExecution(job: ConnectorJob): Promise<Record<string, unknown>> {
  const inp = job.input;
  switch (job.operation) {
    case 'create_from_template':
      return handleCreateFromTemplate({
        connectorId: inp.connectorId as string,
        tenantId: inp.tenantId as string,
        body: inp.body as CreateFromTemplateBody,
      }) as unknown as Promise<Record<string, unknown>>;
    case 'copy_and_replace':
      return handleCopyAndReplace({
        connectorId: inp.connectorId as string,
        tenantId: inp.tenantId as string,
        presentationId: inp.presentationId as string,
        body: inp.body as { name?: string; replacements?: Array<{ find: string; replace: string }> },
      }) as unknown as Promise<Record<string, unknown>>;
    case 'copy_and_edit_document':
      return handleCopyAndEditDocument({
        connectorId: inp.connectorId as string,
        tenantId: inp.tenantId as string,
        documentId: inp.documentId as string,
        body: inp.body as { name?: string; edits?: Array<{ find: string; replace: string }> },
      }) as unknown as Promise<Record<string, unknown>>;
    case 'create_google_doc':
      return handleCreateGoogleDoc({
        connectorId: inp.connectorId as string,
        tenantId: inp.tenantId as string,
        body: inp.body as CreateGoogleDocBody,
      }) as unknown as Promise<Record<string, unknown>>;
    default:
      throw new Error(`Unknown operation: ${job.operation}`);
  }
}

executeRouter.post('/jobs/:jobId/execute', async (req, res) => {
  const { jobId } = req.params;

  // Atomic claim — prevents double-execution on Cloud Tasks retry.
  const job = await claimJobForExecution(jobId);
  if (!job) {
    // Job not found, already running, or already complete/failed.
    // Return 200 so Cloud Tasks does NOT retry.
    return res.status(200).json({ ok: true, reason: 'already_claimed_or_not_found' });
  }

  try {
    const result = await runJobExecution(job);
    await updateJob(job.id, { status: 'complete', result });
    return res.status(200).json({ ok: true });
  } catch (err) {
    const error = isReconnectRequiredOAuthError(err)
      ? 'reconnect_required'
      : (err as Error).message;
    logger.error({ err, jobId, operation: job.operation }, 'job execute failed');
    await updateJob(job.id, { status: 'failed', error });
    // Always return 200 — application errors must not trigger Cloud Tasks retry.
    return res.status(200).json({ ok: false, error });
  }
});

// Used by queue.ts local dev fallback — executes job in-process synchronously.
export async function executeJobInProcess(jobId: string): Promise<void> {
  const job = await claimJobForExecution(jobId);
  if (!job) return;

  try {
    const result = await runJobExecution(job);
    await updateJob(job.id, { status: 'complete', result });
  } catch (err) {
    const error = isReconnectRequiredOAuthError(err)
      ? 'reconnect_required'
      : (err as Error).message;
    logger.error({ err, jobId, operation: job.operation }, 'job execute (in-process) failed');
    await updateJob(job.id, { status: 'failed', error });
  }
}
