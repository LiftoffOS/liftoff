// Chat-turn worker (Slack + Teams).
//
// POST /api/internal/chat-turns/execute — Cloud Tasks delivery target. Runs the
// full chat turn (placeholder, TR stream, finalize) INSIDE this request so the
// instance has CPU and cannot be reclaimed mid-turn; the receive paths only
// validate, dedupe, and enqueue.
//
// Response-code contract: 200 on success AND on permanently-malformed payloads
// (Cloud Tasks must never retry poison); 5xx only for transient failures so the
// queue redelivers. Event-level dedupe lives in the RECEIVE paths (their check
// inserts on first sight — running it here would drop this task's own retry);
// worker idempotency is the named task.
//
// Auth: OIDC from the chat-turns queue SA (audience = this backend), with the
// same local-dev shared-secret fallback as the MCP chat-run worker.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import type { ChatTurnTask } from './chat-turn-dispatch';
import { verifyWorkerOidc } from './worker-oidc';

export const chatTurnWorkerRouter = Router();

chatTurnWorkerRouter.post('/execute', async (req: Request, res: Response) => {
  if (!(await verifyWorkerOidc(req))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const raw = typeof req.body === 'string'
    ? JSON.parse(Buffer.from(req.body, 'base64').toString())
    : req.body;
  const payload = (raw ?? {}) as { surface?: unknown; task?: unknown };
  const surface = payload.surface;
  if ((surface !== 'slack' && surface !== 'teams')
    || !payload.task || typeof payload.task !== 'object') {
    // Permanent — 200 so Cloud Tasks does not retry a malformed task.
    return res.status(200).json({ dropped: true });
  }
  const task = { surface, task: payload.task } as ChatTurnTask;

  try {
    if (task.surface === 'slack') {
      // The queued payload carries no credential; resolve the bot token from
      // the workspace install at execution time. A missing/revoked install is
      // permanent for this task — nothing to retry against.
      const { findWorkspaceInstallByTeam } = await import('./slack-adapter/workspace-repository');
      const { resolveWorkspaceBotToken } = await import('./slack-adapter/bot-token-service');
      const install = await findWorkspaceInstallByTeam(task.task.slackTeamId);
      const botToken = install ? await resolveWorkspaceBotToken(install) : null;
      if (!botToken) {
        log.warn(
          { slackTeamId: task.task.slackTeamId, tenantId: task.task.tenantId },
          'chat turn dropped: workspace install missing or token unresolvable',
        );
        return res.status(200).json({ dropped: true });
      }
      const { handleSlackChatTask } = await import('./slack-adapter/slack-chat-worker');
      await handleSlackChatTask({ ...task.task, botToken });
    } else {
      const { handleTeamsChatTask } = await import('./teams-adapter/teams-chat-worker');
      await handleTeamsChatTask(task.task);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    // Transient — 5xx so Cloud Tasks retries (bounded by the queue's
    // maxAttempts). The surface workers already contain their own per-turn
    // error messaging; reaching here means the turn machinery itself failed.
    log.error(
      { surface: task.surface, error: (err as Error).message },
      'chat turn worker failed',
    );
    return res.status(500).json({ error: 'chat turn failed' });
  }
});
