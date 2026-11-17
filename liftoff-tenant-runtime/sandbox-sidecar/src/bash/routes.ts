import { Router } from 'express';
import { bashSessionManager } from './session-manager';
import { asyncHandler } from '../shared/error-middleware';

export const bashRoutes = Router();

bashRoutes.post(
  '/sessions/create',
  asyncHandler(async (req, res) => {
    const session = bashSessionManager.create(req.body ?? {});
    res.json({ sessionId: session.sessionId });
  }),
);

bashRoutes.get(
  '/sessions',
  asyncHandler(async (_req, res) => {
    res.json({ sessions: bashSessionManager.list().map(s => s.toDescriptor()) });
  }),
);

bashRoutes.post(
  '/sessions/:id/exec',
  asyncHandler(async (req, res) => {
    const session = bashSessionManager.get(req.params.id);
    const { args, timeout } = req.body as { args: string[]; timeout?: number };
    res.json(await session.exec(args, timeout));
  }),
);

bashRoutes.post(
  '/sessions/:id/write',
  asyncHandler(async (req, res) => {
    // Best-effort: bash sessions are non-PTY. Write is a no-op for now
    // (long-running attached child support is documented future work).
    bashSessionManager.get(req.params.id);
    res.json({ success: true });
  }),
);

bashRoutes.post(
  '/sessions/:id/kill',
  asyncHandler(async (req, res) => {
    bashSessionManager.destroy(req.params.id);
    res.json({ success: true });
  }),
);

bashRoutes.get(
  '/sessions/:id/output',
  asyncHandler(async (req, res) => {
    res.json(bashSessionManager.get(req.params.id).output());
  }),
);

bashRoutes.delete(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    bashSessionManager.destroy(req.params.id);
    res.json({ success: true });
  }),
);
