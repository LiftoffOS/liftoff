import { Router } from 'express';
import { ptyManager } from './pty-manager';
import { shellExec } from './exec';
import { ticketStore } from '../auth/ticket-store';
import { asyncHandler } from '../shared/error-middleware';
import { config } from '../config';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';
import type {
  ShellExecRequest,
  ShellSessionCreateRequest,
  ShellSessionWriteRequest,
  ShellSessionWaitRequest,
  ShellSessionResizeRequest,
} from '@liftoffos/sandbox-contracts';

export const shellRoutes = Router();

shellRoutes.post(
  '/exec',
  asyncHandler(async (req, res) => {
    const body = req.body as ShellExecRequest;
    const result = await shellExec(body);
    res.json(result);
  }),
);

shellRoutes.post(
  '/sessions/create',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as ShellSessionCreateRequest;
    if (body.cwd) validateWorkspacePath(body.cwd);
    const session = ptyManager.create(body);
    res.json({ sessionId: session.sessionId });
  }),
);

shellRoutes.get(
  '/sessions',
  asyncHandler(async (_req, res) => {
    res.json({ sessions: ptyManager.list() });
  }),
);

shellRoutes.get(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    const session = ptyManager.get(req.params.id);
    const stats = session.stats();
    res.json({ sessionId: session.sessionId, ...stats });
  }),
);

shellRoutes.post(
  '/sessions/:id/write',
  asyncHandler(async (req, res) => {
    const body = req.body as ShellSessionWriteRequest;
    const session = ptyManager.get(req.params.id);
    session.write(body.data);
    res.json({ success: true });
  }),
);

shellRoutes.post(
  '/sessions/:id/wait',
  asyncHandler(async (req, res) => {
    const body = req.body as ShellSessionWaitRequest;
    const session = ptyManager.get(req.params.id);
    const result = await session.waitForExit(Math.min(body.timeout_ms ?? 30_000, 300_000));
    res.json(result);
  }),
);

shellRoutes.delete(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    ptyManager.destroy(req.params.id);
    res.json({ success: true });
  }),
);

shellRoutes.get(
  '/sessions/:id/view',
  asyncHandler(async (req, res) => {
    const session = ptyManager.get(req.params.id);
    const offset = parseInt((req.query.offset as string) ?? '0', 10);
    const view = session.view(offset);
    res.json(view);
  }),
);

shellRoutes.put(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    const body = req.body as ShellSessionResizeRequest;
    const session = ptyManager.get(req.params.id);
    if (typeof body.cols === 'number' && typeof body.rows === 'number') {
      session.resize(body.cols, body.rows);
    }
    res.json({ success: true });
  }),
);

shellRoutes.post(
  '/sessions/:id/cleanup',
  asyncHandler(async (req, res) => {
    ptyManager.destroy(req.params.id);
    res.json({ success: true });
  }),
);

shellRoutes.post(
  '/sessions/cleanup-all',
  asyncHandler(async (_req, res) => {
    await ptyManager.killAll();
    res.json({ success: true });
  }),
);

shellRoutes.get(
  '/sessions/:id/stats',
  asyncHandler(async (req, res) => {
    const session = ptyManager.get(req.params.id);
    res.json(session.stats());
  }),
);

shellRoutes.get(
  '/terminal-url',
  asyncHandler(async (_req, res) => {
    const { ticket } = ticketStore.issue('vscode', 300_000);
    res.json({ url: `${config.sandboxPublicUrl}/vscode/?ticket=${ticket}&folder=/workspace` });
  }),
);
