// External Agents Rediscover Stream Router
// SSE endpoint for streaming progress during MCP rediscovery of existing agents
// Follows discover-stream-router.ts pattern

import { Router, Request, Response } from 'express';
import { discoverExternalAgentWithProgress, type DiscoverStage } from './discover-adapter';
import { externalAgentService } from './service';
import { log } from '../infrastructure/logging';

export const rediscoverExternalAgentStreamRouter = Router();

// POST /api/external-agents/:id/rediscover-stream
// SSE endpoint for MCP rediscovery with progress updates
rediscoverExternalAgentStreamRouter.post('/:id', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  const externalAgentId = req.params.id;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  // Fetch existing agent to get endpoint and auth config
  const existingAgent = await externalAgentService.get(externalAgentId, tenantId);
  if (!existingAgent) {
    return res.status(404).json({ error: 'External agent not found' });
  }

  log.info(
    { tenantId, externalAgentId, name: existingAgent.name, endpoint: existingAgent.endpointUrl },
    'Starting rediscover stream'
  );

  // Set up SSE headers (same as discover-stream-router.ts)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx/Cloud Run buffering

  // Prevent response compression which can buffer SSE
  res.setHeader('Content-Encoding', 'identity');

  res.flushHeaders();

  // Helper to send SSE events
  const sendEvent = (event: string, data: object) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial connected event
  sendEvent('progress', { stage: 'connected' as DiscoverStage });

  // Handle client disconnect
  let aborted = false;
  req.on('close', () => {
    aborted = true;
    log.info({ tenantId, externalAgentId }, 'Rediscover stream client disconnected');
  });

  try {
    // Progress callback - sends SSE events as stages complete
    const onProgress = (stage: DiscoverStage) => {
      if (!aborted) {
        sendEvent('progress', { stage });
      }
    };

    // Fetch credentials from Secret Manager to pass to discovery
    // Note: For rediscovery, we use the stored auth config from the existing agent
    // The actual credentials are stored in Secret Manager and retrieved by the MCP client
    const discoveryInput = {
      endpointUrl: existingAgent.endpointUrl,
      name: existingAgent.name,
      description: existingAgent.description || '',
      authType: existingAgent.authType,
      tenantId,
      agentId: externalAgentId,
      // Note: Credentials are fetched from Secret Manager by discover-service
      // We don't pass them here for security - they're retrieved at runtime
    };

    const discoveryResult = await discoverExternalAgentWithProgress(discoveryInput, onProgress);

    // Update the existing agent with new discovery results
    const { agent, requiresReview, changes } = await externalAgentService.rediscover(
      externalAgentId,
      tenantId,
      {
        capabilities: discoveryResult.capabilities,
        resources: discoveryResult.resources,
        toolClassifications: discoveryResult.toolClassifications,
        // The effect class rides beside the categories; the cache upsert
        // writes what it is handed, so a rediscovery that dropped these would
        // null the class every tool already had.
        toolEffectClasses: discoveryResult.toolEffectClasses,
        toolClassificationVersions: discoveryResult.toolClassificationVersions,
        rawMcpTools: discoveryResult.rawMcpTools,
        rawMcpResources: discoveryResult.rawMcpResources,
        transportType: discoveryResult.transportType,
        summary: discoveryResult.summary,
        collaborationHints: discoveryResult.collaborationHints,
      }
    );

    if (!aborted) {
      sendEvent('complete', {
        agent,
        requiresReview,
        changes,
      });
      log.info(
        { tenantId, externalAgentId, requiresReview, changesCount: changes.length },
        'Rediscover stream completed successfully'
      );
    }
  } catch (error) {
    if (!aborted) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      sendEvent('error', { message });
    }
    log.error({ error, tenantId, externalAgentId }, 'Rediscover stream failed');
  } finally {
    res.end();
  }
});
