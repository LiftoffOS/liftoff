// Custom MCP Servers REST API Router.
//
// Mirror of external-agents/router.ts patterns for the tools-only consumer
// of the shared MCP plumbing.
//
// Auth: gated by `tenantAuthMiddleware('manageConnectors')`. The middleware
// reads tenantId from `req.params.tenantId | req.query.tenantId | req.body.tenantId`,
// verifies the firebase-authenticated user is a member of that tenant with
// `manageConnectors` permission (owner/admin), and sets
// `req.ctx.tenantId` + `(req as any).actorAccountId`. Audit calls use
// `auditCtx(req)` so the audit row's `user_id` is the workspace accountId
// (UUID) — not the firebase UID, which would be NULLed by the audit flush
// and never appear in the unified feed.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { customMcpServerService } from './service';
import type { CustomMcpServer } from './types';
import { log, logAudit } from '../infrastructure/logging';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { auditCtx } from '../infrastructure/audit-context';

export const customMcpServersRouter = Router();

function pickAuditFields(server: CustomMcpServer): Record<string, unknown> {
  return {
    name: server.name,
    endpointUrl: server.endpointUrl,
    deliveryMode: server.deliveryMode,
    authType: server.authType,
    tunnelRouteId: server.tunnelRouteId,
  };
}

const customHeaderSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().min(1).max(1000),
});

const createSchema = z.object({
  name: z.string().min(1).max(255),
  deliveryMode: z.enum(['public_url', 'tunneled']),
  endpointUrl: z.string().url().max(2000).optional(),
  authType: z.enum(['none', 'api_key', 'bearer_token', 'custom_headers']),
  apiKey: z.string().max(4000).optional(),
  bearerToken: z.string().max(4000).optional(),
  customHeaders: z.array(customHeaderSchema).max(20).optional(),
  tunnelRouteId: z.string().uuid().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  endpointUrl: z.string().url().max(2000).optional(),
  authType: z.enum(['none', 'api_key', 'bearer_token', 'custom_headers']).optional(),
  apiKey: z.string().max(4000).optional(),
  bearerToken: z.string().max(4000).optional(),
  customHeaders: z.array(customHeaderSchema).max(20).optional(),
});

customMcpServersRouter.get(
  '/',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    try {
      const servers = await customMcpServerService.list(tenantId);
      res.json({ servers });
    } catch (error) {
      log.error({ error }, 'Failed to list custom MCP servers');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

customMcpServersRouter.get(
  '/:id',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    try {
      const server = await customMcpServerService.get(tenantId, req.params.id);
      if (!server) return res.status(404).json({ error: 'Custom MCP server not found' });
      res.json(server);
    } catch (error) {
      log.error({ error }, 'Failed to get custom MCP server');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

customMcpServersRouter.post(
  '/',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    const parseResult = createSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }
    const input = parseResult.data;
    if (input.authType === 'api_key' && !input.apiKey) {
      return res.status(400).json({ error: 'API key required for api_key auth type' });
    }
    if (input.authType === 'bearer_token' && !input.bearerToken) {
      return res.status(400).json({ error: 'Bearer token required for bearer_token auth type' });
    }
    if (input.authType === 'custom_headers' && (!input.customHeaders || input.customHeaders.length === 0)) {
      return res.status(400).json({ error: 'Custom headers required for custom_headers auth type' });
    }

    const accountId = req.ctx?.userId;
    if (!accountId) {
      return res.status(401).json({ error: 'Authenticated user required' });
    }

    try {
      const server = await customMcpServerService.create(tenantId, accountId, input);
      logAudit('mcp_server.added', auditCtx(req), {
        resourceType: 'custom_mcp_server',
        resourceId: server.id,
        newState: pickAuditFields(server),
      });
      res.status(201).json(server);
    } catch (error) {
      log.error({ error }, 'Failed to create custom MCP server');
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

customMcpServersRouter.patch(
  '/:id',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    const parseResult = updateSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }
    // Switching TO a credentialed auth type must carry the credential. Without
    // this the server would be left claiming bearer auth with no bearer to
    // send, which fails at dispatch rather than here where it can be fixed.
    // Re-sending the SAME authType with no credential is allowed and means
    // "leave the stored secret alone" — the editor shows a masked value it
    // cannot read back, so it has nothing to resubmit.
    const patch = parseResult.data;
    const authTypeChanged =
      patch.authType !== undefined
      && patch.authType !== (await customMcpServerService.get(tenantId, req.params.id))?.authType;
    if (authTypeChanged) {
      if (patch.authType === 'api_key' && !patch.apiKey) {
        return res.status(400).json({ error: 'API key required for api_key auth type' });
      }
      if (patch.authType === 'bearer_token' && !patch.bearerToken) {
        return res.status(400).json({ error: 'Bearer token required for bearer_token auth type' });
      }
      if (patch.authType === 'custom_headers' && (!patch.customHeaders || patch.customHeaders.length === 0)) {
        return res.status(400).json({ error: 'Custom headers required for custom_headers auth type' });
      }
    }
    try {
      const prior = await customMcpServerService.get(tenantId, req.params.id);
      const server = await customMcpServerService.update(tenantId, req.params.id, parseResult.data);
      if (!server) return res.status(404).json({ error: 'Custom MCP server not found' });
      logAudit('mcp_server.updated', auditCtx(req), {
        resourceType: 'custom_mcp_server',
        resourceId: req.params.id,
        previousState: prior ? pickAuditFields(prior) : undefined,
        newState: pickAuditFields(server),
      });
      res.json(server);
    } catch (error) {
      log.error({ error }, 'Failed to update custom MCP server');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

customMcpServersRouter.delete(
  '/:id',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    const accountId = req.ctx?.userId;
    if (!accountId) {
      return res.status(401).json({ error: 'Authenticated user required' });
    }
    try {
      const prior = await customMcpServerService.get(tenantId, req.params.id);
      const ok = await customMcpServerService.delete(tenantId, accountId, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Custom MCP server not found' });
      logAudit('mcp_server.removed', auditCtx(req), {
        resourceType: 'custom_mcp_server',
        resourceId: req.params.id,
        previousState: prior ? pickAuditFields(prior) : undefined,
      });
      res.status(204).end();
    } catch (error) {
      log.error({ error }, 'Failed to delete custom MCP server');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// Rediscover (non-streaming). Mirrors the external-agents pattern but
// returns the final result synchronously; the frontend uses this for the
// Manage modal where SSE isn't necessary.
customMcpServersRouter.post(
  '/:id/rediscover',
  tenantAuthMiddleware('manageConnectors'),
  async (req: Request, res: Response) => {
    const tenantId = req.ctx!.tenantId!;
    try {
      const server = await customMcpServerService.rediscover(tenantId, req.params.id, () => {
        /* progress callback noop */
      });
      if (!server) return res.status(404).json({ error: 'Custom MCP server not found' });
      const toolCount = Array.isArray((server as unknown as { tools?: unknown[] }).tools)
        ? (server as unknown as { tools: unknown[] }).tools.length
        : undefined;
      logAudit('mcp_server.rediscovered', auditCtx(req), {
        resourceType: 'custom_mcp_server',
        resourceId: req.params.id,
        newState: { toolCount },
      });
      res.json(server);
    } catch (error) {
      log.error({ error }, 'Failed to rediscover custom MCP server');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);
