// External Agents Discover Stream Router
// SSE endpoint for streaming progress during MCP discovery and LLM analysis
// Follows distill-stream-router.ts pattern exactly

import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { discoverExternalAgentWithProgress, type DiscoverStage } from './discover-adapter';
import { log } from '../infrastructure/logging';
import { assertPublicUrl, BlockedUrlError } from '../common/url-guard';

export const discoverExternalAgentStreamRouter = Router();

// Custom header schema for custom_headers auth type
const customHeaderSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().min(1).max(1000),
});

// Zod validation schema for discover input
const discoverInputSchema = z.object({
  endpointUrl: z.string().url().max(2000),
  name: z.string().min(1).max(255),
  description: z.string().max(10000).optional().default(''),
  authType: z.enum(['none', 'api_key', 'bearer_token', 'custom_headers']).default('none'),
  apiKey: z.string().max(1000).optional(),
  bearerToken: z.string().max(2000).optional(),
  customHeaders: z.array(customHeaderSchema).max(10).optional(),
});

// POST /api/external-agents/discover-stream
// SSE endpoint for MCP discovery with progress updates
discoverExternalAgentStreamRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  // Validate input before setting up SSE
  const parseResult = discoverInputSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: parseResult.error.errors,
    });
  }

  const input = parseResult.data;

  // Validate auth credentials based on auth type
  if (input.authType === 'api_key' && !input.apiKey) {
    return res.status(400).json({ error: 'API key required for api_key auth type' });
  }
  if (input.authType === 'bearer_token' && !input.bearerToken) {
    return res.status(400).json({ error: 'Bearer token required for bearer_token auth type' });
  }
  if (input.authType === 'custom_headers' && (!input.customHeaders || input.customHeaders.length === 0)) {
    return res.status(400).json({ error: 'Custom headers required for custom_headers auth type' });
  }

  // E1: discovery CONNECTS to this URL. Guard before the SSE stream opens, so
  // a refusal is an ordinary 400 the form can show rather than an error event
  // mid-stream.
  try {
    await assertPublicUrl(input.endpointUrl, { context: 'external-agents.discover' });
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      return res.status(400).json({ error: 'Endpoint URL is not reachable from the platform', reason: err.reason });
    }
    throw err;
  }

  log.info({ tenantId, name: input.name, endpoint: input.endpointUrl }, 'Starting discover stream');

  // Set up SSE headers (same as distill-stream-router.ts)
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
    log.info({ tenantId, name: input.name }, 'Discover stream client disconnected');
  });

  try {
    // Progress callback - sends SSE events as stages complete
    const onProgress = (stage: DiscoverStage) => {
      if (!aborted) {
        sendEvent('progress', { stage });
      }
    };

    const correlationId = randomUUID();
    const result = await discoverExternalAgentWithProgress({ ...input, tenantId, correlationId }, onProgress);

    if (!aborted) {
      sendEvent('complete', result);
      log.info({ tenantId, name: input.name }, 'Discover stream completed successfully');
    }
  } catch (error) {
    if (!aborted) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      sendEvent('error', { message });
    }
    log.error({ error, tenantId, name: input.name }, 'Discover stream failed');
  } finally {
    res.end();
  }
});
