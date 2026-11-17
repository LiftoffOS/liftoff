// Custom MCP Servers Internal Service Router.
//
// Service-auth endpoints used by tenant-runtime's tool-schema-cache: a list of
// the tenant's servers and a version-tagged raw-tools snapshot per server.
//
// Execution-time runtime-config resolution (endpoint + auth) is NOT here — it
// goes through the unified connection door,
// GET /api/internal/connections/:connectorId/runtime-config
// (connections/runtime-config-router.ts).
//
// All `id` query params on these routes are the canonical connection
// identifier — `connectors.id`, also stored as agent integration bindings
// and used in /connections URLs. Post migration 268 this is identical to
// `custom_mcp_servers.connector_id` (now the PK).

import { Router, Request, Response } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { customMcpServerService } from './service';
import { log } from '../infrastructure/logging';
import { isTypeSafeClassifierEnabled } from '../typesafe/flags';

export const customMcpServersInternalRouter = Router();

const serviceAuthMiddleware = verifyServiceAuth();

// GET /api/internal/custom-mcp-servers?tenantId=
// Returns the list of custom MCP servers for a tenant — used by tenant-runtime's
// tool-schema-cache to enumerate which per-server raw-tools to refresh.
customMcpServersInternalRouter.get(
  '/internal/custom-mcp-servers',
  serviceAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
      const servers = await customMcpServerService.list(tenantId);
      res.json({
        servers: servers.map((s) => ({
          id: s.id,
          name: s.name,
          connectorId: s.connectorId,
          // Kept for an older runtime that compares it.
          updatedAt: s.updatedAt.toISOString(),
          // What the runtime compares and stores (1b): `<updatedAt>|<classifier>`,
          // the same string the raw-tools endpoint returns as `version`.
          version: customMcpServerService.cacheVersion(s),
        })),
      });
    } catch (error) {
      log.error({ error }, 'Failed to list custom MCP servers (internal)');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);

// GET /api/internal/custom-mcp-servers/by-id/raw-tools?tenantId=&id=
// Returns { tools, version, effectClasses } for the tool-schema-cache refresh
// loop. The version is `<updated_at>|<classifier>` (customMcpCacheVersion), the
// same string the list endpoint carries per server, so the cache can
// short-circuit when nothing has changed and refetch when the classifier's
// flag or version has. `effectClasses` is the 1b class per bare tool name,
// omitted for tools with none and empty while the classifier kill is off.
customMcpServersInternalRouter.get(
  '/internal/custom-mcp-servers/by-id/raw-tools',
  serviceAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.query.tenantId as string;
      const id = req.query.id as string;
      if (!tenantId || !id) return res.status(400).json({ error: 'tenantId and id required' });
      const server = await customMcpServerService.get(tenantId, id);
      if (!server) return res.status(404).json({ error: 'Custom MCP server not found' });
      const effectClasses = await customMcpServerService.effectClassesFor(server);
      res.json({
        tools: server.rawMcpTools,
        version: customMcpServerService.cacheVersion(server),
        effectClasses,
        // Stated on the wire beside the version segment, so the runtime's
        // mapper can refuse to append even when handed a class.
        classifierEnabled: isTypeSafeClassifierEnabled(),
      });
    } catch (error) {
      log.error({ error }, 'Failed to fetch custom MCP server raw tools');
      res.status(500).json({ error: (error as Error).message });
    }
  },
);
