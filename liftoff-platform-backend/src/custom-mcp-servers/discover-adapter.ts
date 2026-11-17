// Custom MCP Server Discover Adapter.
//
// Thin adapter over the generic discovery pipeline at
// src/mcp/discovery-pipeline.ts. Persists results into custom_mcp_servers
// (specifically raw_mcp_tools); summary/collaborationHints are discarded
// — custom MCP servers are tools-only and don't surface a collaborator
// description.

import { runDiscoveryPipeline, type ProgressCallback } from '../mcp/discovery-pipeline';
import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { toolClassifier } from '../mcp/tool-classifier';
import type { DiscoverInput, DiscoverOutput } from '../mcp/types';

export type { ProgressCallback };

/** The identity the service layer writes a custom server's classifications
 *  under (cacheToolClassifications): `custom_mcp_server:<id>`, the bare tool
 *  name, the tenant. The lookup reads exactly that, so the two cannot
 *  disagree about which row is this server's. */
export function customMcpClassificationIntegrationType(serverId: string): string {
  return `custom_mcp_server:${serverId}`;
}

export async function discoverCustomMcpServerWithProgress(
  input: DiscoverInput & {
    /** Set on a REDISCOVERY, where the server already has classifications
     *  under its own identity. Absent on the first discovery, which
     *  classifies everything. */
    rediscoverServerId?: string;
  },
  onProgress: ProgressCallback,
): Promise<DiscoverOutput> {
  const serverId = input.rediscoverServerId;
  const tenantId = input.tenantId;
  return runDiscoveryPipeline(
    {
      endpointUrl: input.endpointUrl,
      name: input.name,
      description: input.description,
      authType: input.authType,
      apiKey: input.apiKey,
      bearerToken: input.bearerToken,
      customHeaders: input.customHeaders,
      tenantId: input.tenantId,
      agentId: input.agentId,
      correlationId: input.correlationId,
      ...(serverId && tenantId
        ? {
            classificationLookup: (tool) => toolClassifier.getCachedClassification(
              tool.name,
              customMcpClassificationIntegrationType(serverId),
              tenantId,
            ),
          }
        : {}),
    },
    onProgress,
  );
}

/**
 * Persist a freshly discovered tools snapshot to a custom_mcp_servers row.
 * Used by the rediscover endpoint and by the create flow after the initial
 * discovery returns.
 */
export async function persistCustomMcpServerTools(
  connectorId: string,
  output: DiscoverOutput,
): Promise<void> {
  await pool.query(
    `UPDATE custom_mcp_servers
       SET raw_mcp_tools = $1::jsonb, updated_at = NOW()
     WHERE connector_id = $2`,
    [JSON.stringify(output.rawMcpTools), connectorId],
  );
  log.info(
    { connectorId, toolCount: output.rawMcpTools.length },
    'Custom MCP server tools persisted',
  );
}
