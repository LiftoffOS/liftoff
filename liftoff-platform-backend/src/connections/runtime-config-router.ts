// Unified connection runtime-config endpoint.
//
// Single internal lookup the execution plane uses to resolve any
// connection on the /connections page (Gmail, Slack, custom_mcp_server,
// tunneled MCP, future API connectors) into the runtime config it needs
// to actually invoke that connection.
//
// Contract:
//   - The path param is `connectors.id` — the same identifier the agent
//     binding stores in `integration.id` and the same identifier used
//     elsewhere in the system. There is no second id form.
//   - The response is a discriminated union keyed on `type`. Each
//     connection type has a resolver that knows how to assemble its
//     runtime config from the type-specific table.
//   - Adding a new connector type means adding a resolver case here.
//     New `/api/internal/<type>/by-id` endpoints are not required and
//     should not be added — every runtime lookup goes through this one
//     door. That eliminates the failure mode where two endpoints
//     disagree about what an id means.

import { Router, Request, Response } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { customMcpServerService } from '../custom-mcp-servers/service';
import type { CustomMcpServer } from '../custom-mcp-servers/types';

export const connectionsInternalRouter = Router();

const serviceAuthMiddleware = verifyServiceAuth();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Discriminated-union response. Each variant carries the connection's
// runtime config plus a `type` tag so callers can switch on it.
type RuntimeConfig =
  | {
      type: 'custom_mcp_server';
      connectorId: string;
      tenantId: string;
      config: CustomMcpServer;
      /**
       * The resolved credential, so the execution plane never reads Secret
       * Manager itself.
       *
       * It could not: the secret lives in THIS project and the tenant runtime's
       * service account has no secretAccessor here, so every custom MCP server
       * failed its credential read, refused to connect unauthenticated, and
       * contributed no tools — while the connections page showed it healthy.
       * See customMcpServerService.resolveRuntimeCredentials.
       *
       * Absent when the server declares `authType: 'none'`, or when the secret
       * cannot be read — the caller must treat absent-but-required as a refusal
       * to connect, never as "no auth needed".
       */
      credentials?: { apiKey?: string; bearerToken?: string; customHeaders?: unknown };
    };

type Resolver = (tenantId: string, connectorId: string) => Promise<RuntimeConfig | null>;

// Resolver registry. Adding a new connector type means adding one entry
// here that maps the type string from `connectors.type` to a resolver.
const RESOLVERS: Record<string, Resolver> = {
  custom_mcp_server: async (tenantId, connectorId) => {
    const server = await customMcpServerService.get(tenantId, connectorId);
    if (!server) return null;
    const credentials = await customMcpServerService.resolveRuntimeCredentials(tenantId, connectorId);
    if (server.authType !== 'none' && !credentials) {
      // Loud, because the alternative is a server that dispatches nothing and
      // says nothing. The caller still gets the config and still refuses to
      // connect unauthenticated; this line is what makes the cause findable.
      log.error(
        { tenantId, connectorId, authType: server.authType, authSecretName: server.authSecretName },
        'custom MCP server declares auth but its credential could not be resolved — it will contribute no tools',
      );
    }
    return { type: 'custom_mcp_server', connectorId, tenantId, config: server, credentials: credentials ?? undefined };
  },
};

// GET /api/internal/connections/:connectorId/runtime-config?tenantId=<uuid>
//
// Returns the discriminated-union runtime config for the connection with
// the given `connectors.id`, scoped to the tenant. 404 if the connector
// doesn't exist for this tenant, 400 if its type has no registered
// resolver (a custom_connector_type someone added without wiring it
// here — fails loudly so the gap is visible).
connectionsInternalRouter.get(
  '/internal/connections/:connectorId/runtime-config',
  serviceAuthMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { connectorId } = req.params;
      const tenantId = req.query.tenantId as string;
      if (!tenantId || !connectorId) {
        return res.status(400).json({ error: 'tenantId query param and connectorId path param required' });
      }
      if (!UUID_REGEX.test(tenantId) || !UUID_REGEX.test(connectorId)) {
        return res.status(400).json({ error: 'tenantId and connectorId must be UUIDs' });
      }

      // Look up the connector row to discover its type, then dispatch.
      const connectorRow = await withTenantScope(tenantId, (client) => client.query<{ type: string }>(
        `SELECT type FROM connectors WHERE id = $1 AND tenant_id = $2`,
        [connectorId, tenantId],
      ));
      if (connectorRow.rows.length === 0) {
        return res.status(404).json({ error: 'Connection not found for tenant', connectorId, tenantId });
      }
      const connectorType = connectorRow.rows[0].type;

      const resolver = RESOLVERS[connectorType];
      if (!resolver) {
        return res.status(400).json({
          error: 'No runtime-config resolver registered for connector type',
          connectorType,
          connectorId,
        });
      }

      const runtimeConfig = await resolver(tenantId, connectorId);
      if (!runtimeConfig) {
        return res.status(404).json({
          error: 'Connector exists but type-specific config not found',
          connectorType,
          connectorId,
        });
      }

      return res.json(runtimeConfig);
    } catch (error) {
      log.error({ error, connectorId: req.params.connectorId }, 'runtime-config lookup failed');
      return res.status(500).json({ error: (error as Error).message });
    }
  },
);
