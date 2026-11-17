// Connectors Service
// Per Section 11 & 12: Connectors, ingestion, and raw payload archival

import { Router } from 'express';
import { ConnectorService } from './service';
import { payloadArchiver } from './payload-archiver';
import { webhookSignatureMiddleware } from '../middleware/webhook-signature-middleware';

export const connectorsRouter = Router();
const service = new ConnectorService();

// Per Section 12: HMAC signature verification middleware for webhooks
const verifyWebhookSignature = webhookSignatureMiddleware();

// List available connectors
connectorsRouter.get('/', async (req, res) => {
  const connectors = await service.listConnectors();
  res.json(connectors);
});

// Get connector status
connectorsRouter.get('/:connectorId/status', async (req, res) => {
  const status = await service.getStatus(req.params.connectorId);
  res.json(status);
});

// Webhook endpoint for connectors
// Per Section 12: Webhook or poller runs on Cloud Run
// Per Section 12: HMAC signature verification for webhook security
connectorsRouter.post('/:connectorId/webhook', verifyWebhookSignature, async (req, res) => {
  await service.handleWebhook(req.params.connectorId, req.body);
  res.json({ status: 'received' });
});

// Trigger manual sync
connectorsRouter.post('/:connectorId/sync', async (req, res) => {
  await service.triggerSync(req.params.connectorId);
  res.json({ status: 'syncing' });
});

// ============================================
// Per Section 11: Raw payload archival APIs
// Supports replay, reconciliation, and auditable writes
// ============================================

// List archived payloads for a connector
connectorsRouter.get('/:connectorId/archives', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const { connectorId } = req.params;
  const { payloadType, startDate, endDate, limit, offset } = req.query;

  const result = await payloadArchiver.list(tenantId, {
    connectorId,
    payloadType: payloadType as any,
    startDate: startDate ? new Date(startDate as string) : undefined,
    endDate: endDate ? new Date(endDate as string) : undefined,
    limit: limit ? parseInt(limit as string) : undefined,
    offset: offset ? parseInt(offset as string) : undefined,
  });

  res.json(result);
});

// Get a specific archived payload
connectorsRouter.get('/archives/:archiveId', async (req, res) => {
  const { archiveId } = req.params;
  const { includePayload } = req.query;

  try {
    const result = await payloadArchiver.retrieve(archiveId);
    if (includePayload !== 'true') {
      res.json({ metadata: result.metadata });
    } else {
      res.json(result);
    }
  } catch {
    res.status(404).json({ error: 'Archive not found' });
  }
});

// Get payloads for replay (reconciliation/debugging)
connectorsRouter.get('/:connectorId/archives/replay', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const { connectorId } = req.params;
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    res.status(400).json({ error: 'startDate and endDate are required' });
    return;
  }

  const payloads = await service.getArchivedPayloads(
    tenantId,
    connectorId,
    new Date(startDate as string),
    new Date(endDate as string)
  );

  res.json({ payloads, count: payloads.length });
});

// Cleanup expired archives (admin endpoint, called by Cloud Scheduler)
connectorsRouter.post('/archives/cleanup', async (req, res) => {
  const deletedCount = await payloadArchiver.cleanupExpired();
  res.json({ deletedCount });
});
