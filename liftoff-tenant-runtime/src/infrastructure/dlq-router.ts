// Dead Letter Queue Router
// Per Section 7: DLQ management endpoints

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { dlqService } from './dlq';
import { logger } from './logging';
import { getManagedSecret } from './secret-store';

// Extend Express Request to include custom context
interface RequestWithContext extends Request {
  ctx?: {
    userId?: string;
    tenantId?: string;
    [key: string]: unknown;
  };
}

// Service auth middleware for DLQ mutation endpoints
const serviceAuthMiddleware = async (req: Request, res: Response, next: () => void) => {
  const serviceToken = req.headers['x-service-auth'] as string | undefined;
  const expectedToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN');

  if (!expectedToken) {
    return res.status(500).json({ error: 'Service authentication not configured' });
  }

  const isValid = serviceToken &&
    Buffer.byteLength(serviceToken) === Buffer.byteLength(expectedToken) &&
    crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expectedToken));

  if (!isValid) {
    return res.status(401).json({ error: 'Invalid service authentication' });
  }

  next();
};

export const dlqRouter = Router();

// List pending DLQ messages
dlqRouter.get('/pending', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const messages = await dlqService.listPending(tenantId);
    res.json(messages);
  } catch (error) {
    next(error);
  }
});

// Get DLQ metrics
dlqRouter.get('/metrics', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const metrics = await dlqService.getMetrics(tenantId);
    res.json(metrics);
  } catch (error) {
    next(error);
  }
});

// Manual retry a DLQ message (requires service auth)
dlqRouter.post('/:id/retry', serviceAuthMiddleware, async (req: RequestWithContext, res, next) => {
  try {
    const result = await dlqService.manualRetry(req.params.id);

    if (!result.success) {
      res.status(404).json({ error: result.error });
      return;
    }

    logger.info('Manual DLQ retry initiated', {
      dlqId: req.params.id,
      triggeredBy: req.ctx?.userId,
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Discard a DLQ message (requires service auth)
dlqRouter.post('/:id/discard', serviceAuthMiddleware, async (req: RequestWithContext, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) {
      res.status(400).json({ error: 'Reason is required' });
      return;
    }

    await dlqService.discard(req.params.id, reason);

    logger.info('DLQ message discarded', {
      dlqId: req.params.id,
      reason,
      triggeredBy: req.ctx?.userId,
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Bulk retry all pending messages for a topic (requires service auth + tenantId)
dlqRouter.post('/bulk-retry', serviceAuthMiddleware, async (req: RequestWithContext, res, next) => {
  try {
    const { originalTopic, tenantId } = req.body;
    if (!tenantId) {
      res.status(400).json({ error: 'tenantId is required for bulk retry' });
      return;
    }
    const pending = await dlqService.listPending(tenantId);

    const filtered = originalTopic
      ? pending.filter((m) => m.originalTopic === originalTopic)
      : pending;

    const results = await Promise.allSettled(
      filtered.map((m) => dlqService.manualRetry(m.id))
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.length - succeeded;

    logger.info('Bulk DLQ retry completed', {
      originalTopic,
      tenantId,
      total: results.length,
      succeeded,
      failed,
      triggeredBy: req.ctx?.userId,
    });

    res.json({ total: results.length, succeeded, failed });
  } catch (error) {
    next(error);
  }
});
