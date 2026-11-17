import { Router } from 'express';
import { runtimeMcpClient } from './runtime-client';
import { asyncHandler } from '../shared/error-middleware';

export const mcpRoutes = Router();

mcpRoutes.get(
  '/tools',
  asyncHandler(async (_req, res) => {
    res.json(await runtimeMcpClient.listTools());
  }),
);

mcpRoutes.post(
  '/dispatch',
  asyncHandler(async (req, res) => {
    const { tool_name, args, idempotency_key } = req.body as { tool_name: string; args: Record<string, unknown>; idempotency_key?: string };
    res.json(await runtimeMcpClient.dispatch(tool_name, args, idempotency_key));
  }),
);

mcpRoutes.post(
  '/await-approval',
  asyncHandler(async (req, res) => {
    const { idempotencyKey, timeout_ms } = req.body as { idempotencyKey: string; timeout_ms?: number };
    res.json(await runtimeMcpClient.awaitApproval(idempotencyKey, timeout_ms ?? 60_000));
  }),
);
