// Execution Environments Router
// Exposes HTTP endpoints for sandbox management operations.
// The GC sweep endpoint is armed while sandboxes exist (armSandboxGcWatch) and
// run by the daily housekeeping pass.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import type { SandboxExecutor, SandboxSession } from './sandbox-executor';
import { SandboxStateRepository, armSandboxGcWatch } from './sandbox-state-repository';

export function createExecutionEnvironmentsRouter(sandboxExecutor: SandboxExecutor): Router {
  const router = Router();

  /**
   * POST /api/execution-environments/gc-sweep
   * Cleans up finished and orphaned sandboxes.
   * Requires internal API key authentication (not tenant-scoped).
   */
  router.post('/gc-sweep', async (_req: Request, res: Response) => {
    try {
      const cleaned = await sandboxExecutor.gcSweep();
      // Best-effort hygiene: expire un-decided sandbox-code HITL approvals past
      // their TTL (DB cleanup; the SDK await-approval timeout already unblocks
      // the script). Never fail the sandbox sweep on this.
      let expiredApprovals = 0;
      try {
        const { expireStaleSandboxApprovals } = await import('../internal-api/sandbox-approval-executor');
        expiredApprovals = await expireStaleSandboxApprovals();
      } catch (err) {
        log.warn({ message: 'sandbox approval expiry sweep failed', error: (err as Error).message });
      }
      log.info({
        message: 'GC sweep completed',
        cleaned,
        expiredApprovals,
      });
      // Come back while anything is still live; stop when nothing is.
      try {
        if (await new SandboxStateRepository().hasLiveSandboxes()) armSandboxGcWatch();
      } catch (err) {
        log.warn({ message: 'sandbox GC re-arm check failed', error: (err as Error).message });
      }
      res.json({ success: true, cleaned, expiredApprovals });
    } catch (err) {
      log.error({
        message: 'GC sweep failed',
        error: (err as Error).message,
      });
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /**
   * The rollback verbs.
   *
   * POST rather than GET for the list too, because the sandbox session is a
   * tenant/agent/session triple and putting that in a query string puts it in
   * every access log between here and the caller.
   *
   * These are the OPERATOR surface. They are deliberately not agent tools: a
   * model that can see its own checkpoints will start rolling back and retrying
   * from the same state, which spends a run rediscovering one failure. The
   * snapshots stay invisible to it.
   */
  router.post('/checkpoints/list', async (req: Request, res: Response) => {
    const session = (req.body as { session?: SandboxSession })?.session;
    if (!session?.sessionId || !session?.tenantId) {
      res.status(400).json({ success: false, error: 'missing_session' });
      return;
    }
    try {
      res.json({ success: true, checkpoints: await sandboxExecutor.listWorkspaceCheckpoints(session) });
    } catch (err) {
      log.error({ message: 'checkpoint list failed', error: (err as Error).message });
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  router.post('/checkpoints/restore', async (req: Request, res: Response) => {
    const body = req.body as { session?: SandboxSession; checkpointId?: string };
    if (!body?.session?.sessionId || !body?.checkpointId) {
      res.status(400).json({ success: false, error: 'missing_session_or_checkpointId' });
      return;
    }
    try {
      const result = await sandboxExecutor.restoreWorkspaceCheckpoint(body.session, body.checkpointId);
      // A refused restore is a 409, not a 500: an unknown checkpoint or a
      // sandbox that has gone is a fact about the request, and a 500 would send
      // the caller looking for a bug in us.
      res.status(result.restored ? 200 : 409).json({ success: result.restored, ...result });
    } catch (err) {
      log.error({ message: 'checkpoint restore failed', error: (err as Error).message });
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /**
   * GET /api/execution-environments/health
   * Health check for sandbox subsystem.
   */
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', subsystem: 'execution-environments' });
  });

  return router;
}
