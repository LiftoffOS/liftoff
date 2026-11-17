import { Router } from 'express';
import { nodeReplManager } from './repl-session';
import { asyncHandler } from '../shared/error-middleware';

export const nodejsRoutes = Router();

nodejsRoutes.post(
  '/sessions/create',
  asyncHandler(async (_req, res) => {
    const s = nodeReplManager.create();
    res.json({ sessionId: s.sessionId });
  }),
);

nodejsRoutes.get(
  '/sessions/list',
  asyncHandler(async (_req, res) => {
    res.json({ sessions: nodeReplManager.list() });
  }),
);

nodejsRoutes.delete(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    await nodeReplManager.destroy(req.params.id);
    res.json({ success: true });
  }),
);

nodejsRoutes.post(
  '/sessions/:id/execute',
  asyncHandler(async (req, res) => {
    const s = nodeReplManager.get(req.params.id);
    res.json(await s.execute(req.body.code as string));
  }),
);

nodejsRoutes.get(
  '/info',
  asyncHandler(async (_req, res) => {
    res.json({ node_version: process.version });
  }),
);
