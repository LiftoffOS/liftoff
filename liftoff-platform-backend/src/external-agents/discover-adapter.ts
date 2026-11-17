// External Agents Discover Adapter
// Phase 0 extraction: thin adapter that calls the generic MCP discovery
// pipeline at src/mcp/discovery-pipeline.ts. Preserves the legacy
// discoverExternalAgentWithProgress() entry point so existing routers and
// SSE streams keep working.

import { runDiscoveryPipeline, type ProgressCallback } from '../mcp/discovery-pipeline';
import { toolClassifier } from '../mcp/tool-classifier';
import type { DiscoverInput, DiscoverOutput, DiscoverStage } from './types';

export type { DiscoverStage, ProgressCallback };

/** The identity the service layer writes an external agent's classifications
 *  under (register / rediscover in service.ts): the tool name prefixed with
 *  the agent id, under `external-agent`, with no tenant (a global row). The
 *  lookup reads exactly that; the tenant is passed too, and the reader falls
 *  through to the global row when no tenant row exists. */
export const EXTERNAL_AGENT_CLASSIFICATION_INTEGRATION_TYPE = 'external-agent';
export function externalAgentClassificationToolName(agentId: string, toolName: string): string {
  return `${agentId}:${toolName}`;
}

export async function discoverExternalAgentWithProgress(
  input: DiscoverInput,
  onProgress: ProgressCallback,
): Promise<DiscoverOutput> {
  // `agentId` is set on a rediscovery and the health sweep, where the agent
  // already has classifications under its own identity; the first discovery
  // has no agent yet and classifies everything.
  const agentId = input.agentId;
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
      ...(agentId
        ? {
            classificationLookup: (tool) => toolClassifier.getCachedClassification(
              externalAgentClassificationToolName(agentId, tool.name),
              EXTERNAL_AGENT_CLASSIFICATION_INTEGRATION_TYPE,
              tenantId,
            ),
          }
        : {}),
    },
    onProgress,
  );
}
