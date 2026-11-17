// Complete an IMPORTED custom MCP server.
//
// The existing custom-MCP modal creates a NEW server. An imported server
// already has both canonical projections (a connectors row and a
// custom_mcp_servers row), created credential-less at bundle-accept time — so
// completing it must heal those exact rows rather than create a second pair.
// Two rows for one server is the duplicate-placeholder failure the import
// design exists to avoid.
//
// Completion is the only point at which a credential enters: the import never
// carried one. It must, in order:
//   1. validate the endpoint or tunnel route,
//   2. store the credential in Liftoff's canonical secret store,
//   3. run MCP tool discovery,
//   4. persist the discovered tools,
//   5. flip BOTH projections to active — and only after discovery succeeded,
//      because a server advertised as connected that returns no tools is worse
//      than one still showing as needing setup.

import { customMcpServerService } from '../custom-mcp-servers/service';
import { tunnelsService } from '../tunnels/service';
import { log } from '../infrastructure/logging';
import { sourceMigrationRepository as repo } from './repository';
import type { SourceMigrationConnection } from './types';

export interface CompleteImportInput {
  /** Fresh credential supplied by the user. Never carried from the source. */
  authType: 'none' | 'api_key' | 'bearer' | 'custom_headers';
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: Array<{ name: string; value: string }>;
  /** Override the imported endpoint, or route through a Liftoff tunnel. */
  endpointUrl?: string;
  tunnelRouteId?: string;
  /** Required for an unauthenticated, reachable endpoint: import must not
   *  silently grant a workspace access to a URL found in a local config file. */
  confirmedUnauthenticated?: boolean;
}

export class CompleteImportError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CompleteImportError';
  }
}

/** Find the imported connection record backing a connector id. */
export async function findImportedConnection(
  tenantId: string,
  migrationId: string,
  connectorId: string,
): Promise<SourceMigrationConnection | null> {
  const rows = await repo.listConnections(tenantId, migrationId);
  return rows.find((r) => r.connectorId === connectorId && r.kind === 'mcp_http') ?? null;
}

export async function completeImportedMcpServer(params: {
  tenantId: string;
  migrationId: string;
  connectorId: string;
  input: CompleteImportInput;
}): Promise<{ connectorId: string; toolCount: number }> {
  const { tenantId, migrationId, connectorId, input } = params;

  const connection = await findImportedConnection(tenantId, migrationId, connectorId);
  if (!connection) {
    throw new CompleteImportError(
      'No imported MCP server matches this connector.',
      404,
      'not_found',
    );
  }

  // Idempotent on migration id plus source ref: completing twice returns the
  // same server rather than making another.
  if (connection.status === 'active') {
    const existing = await customMcpServerService.get(tenantId, connectorId);
    return { connectorId, toolCount: existing?.rawMcpTools.length ?? 0 };
  }

  if (input.authType === 'none' && !input.confirmedUnauthenticated) {
    throw new CompleteImportError(
      'This server accepts unauthenticated requests. Confirm that Liftoff should call it before ' +
        'it is activated.',
      400,
      'confirmation_required',
    );
  }

  // A tunnel selected at completion is resolved to the route's public URL.
  //
  // The canonical update path does not switch an existing server's delivery
  // mode (a natively tunneled server resolves its endpoint FROM the route at
  // create time), so an imported placeholder reaches a customer-network server
  // through the tunnel's public URL. The route id is recorded on the migration
  // connection either way, so the linkage is not lost.
  let endpointUrl = input.endpointUrl ?? connection.endpointUrl ?? undefined;
  if (input.tunnelRouteId) {
    const route = await tunnelsService.getRoute(tenantId, input.tunnelRouteId);
    if (!route) {
      throw new CompleteImportError('Tunnel route not found for this workspace.', 404, 'no_tunnel');
    }
    endpointUrl = route.publicUrl;
  }

  // 1-2. Validation and credential storage are owned by the canonical update
  //      path, which also enforces the public-URL rules. The imported row is
  //      UPDATED, never replaced.
  //
  //      The import vocabulary and the MCP module's vocabulary differ
  //      ('bearer' vs 'bearer_token', header `name` vs `key`). Translating
  //      here, explicitly, keeps the bundle's own terms stable across source
  //      adapters while the platform keeps its.
  const updated = await customMcpServerService.update(tenantId, connectorId, {
    endpointUrl,
    authType: input.authType === 'bearer' ? 'bearer_token' : input.authType,
    apiKey: input.apiKey,
    bearerToken: input.bearerToken,
    customHeaders: input.customHeaders?.map((h) => ({ key: h.name, value: h.value })),
  });

  if (!updated) {
    throw new CompleteImportError('Imported MCP server not found.', 404, 'not_found');
  }

  // 3-4. Discovery. A failure here leaves the server in its needs-reconnect
  //      state on purpose: activating a server whose tools are unknown would
  //      advertise a capability nothing can use.
  let toolCount = 0;
  try {
    const discovered = await customMcpServerService.rediscover(tenantId, connectorId, () => {
      /* no progress surface on this path */
    });
    toolCount = discovered?.rawMcpTools.length ?? 0;
  } catch (err) {
    log.warn(
      { error: (err as Error).message, tenantId, connectorId },
      'source-migrations: imported MCP discovery failed; server stays in needs-reconnect',
    );
    throw new CompleteImportError(
      'Liftoff could not reach that server to list its tools. Check the URL and credentials, ' +
        'then try again.',
      502,
      'discovery_failed',
    );
  }

  // 5. Both projections become active only now.
  await repo.attachConnectorId(tenantId, connection.id, {
    connectorId,
    customMcpServerId: connectorId,
    status: 'active',
  });

  log.info(
    { tenantId, migrationId, connectorId, toolCount },
    'source-migrations: imported MCP server completed',
  );

  return { connectorId, toolCount };
}
