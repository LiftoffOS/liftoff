// SSE Streaming Router
// Per implementation plan: Phase 4.4 API Endpoints

import { Router, Request, Response } from 'express';
import { streamingService } from './service';
import { log } from '../infrastructure/logging';

export const streamingRouter = Router();

// GET /api/threads/:threadId/stream
// Connect to SSE stream for a thread
streamingRouter.get('/:threadId/stream', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    const userId = req.ctx?.userId;
    const { threadId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Flush headers
    res.flushHeaders();

    // Register client
    const client = streamingService.registerClient(res, threadId, tenantId, userId);

    // Send initial connection event
    const connectionEvent = {
      type: 'connected',
      eventId: client.id,
      threadId,
      invocationId: '',
      timestamp: new Date().toISOString(),
      data: {
        clientId: client.id,
        threadId,
      },
    };
    res.write(`event: connected\nid: ${client.id}\ndata: ${JSON.stringify(connectionEvent)}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      streamingService.unregisterClient(client.id, threadId);
    });

    req.on('error', (error) => {
      log.warn({ error, clientId: client.id }, 'SSE connection error');
      streamingService.unregisterClient(client.id, threadId);
    });

  } catch (error) {
    log.error({ error }, 'Failed to setup SSE stream');
    res.status(500).json({ error: (error as Error).message });
  }
});

// GET /api/threads/:threadId/stream/status
// Get stream status (client count)
streamingRouter.get('/:threadId/stream/status', async (req: Request, res: Response) => {
  try {
    const tenantId = req.ctx?.tenantId;
    const { threadId } = req.params;

    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant ID required' });
    }

    const clientCount = streamingService.getClientCount(threadId);

    res.json({
      threadId,
      clientCount,
      hasClients: clientCount > 0,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get stream status');
    res.status(500).json({ error: (error as Error).message });
  }
});
