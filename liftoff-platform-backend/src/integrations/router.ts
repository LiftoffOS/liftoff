import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { log } from '../infrastructure/logging';
import * as repo from './repository';

// User-facing: returns external agent integration metadata for the current tenant.
// Served from platform-backend's own DB — never calls developer-proxy at request time.
// Mounted AFTER authMiddleware in index.ts.
export const integrationsRouter = Router();

integrationsRouter.get(
  '/',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = (req as any).tenantId as string;
      const integrations = await repo.listByTenantId(tenantId);
      return res.json({ externalAgents: integrations });
    } catch (err) {
      next(err);
    }
  },
);

// Service-facing: developer-proxy calls this on credential create/revoke to keep the
// shadow table in sync. Mounted BEFORE authMiddleware in index.ts.
// Auth: DEVELOPER_PROXY_WEBHOOK_TOKEN_SECRET env var via X-Developer-Proxy-Webhook-Token header (timing-safe).
export const devProxyHookRouter = Router();

function verifyDevProxyWebhookToken(req: Request, res: Response, next: () => void): void {
  const expected = process.env.DEVELOPER_PROXY_WEBHOOK_TOKEN_SECRET;
  if (!expected) {
    log.warn('DEVELOPER_PROXY_WEBHOOK_TOKEN_SECRET not configured — developer-proxy-hook endpoint disabled');
    res.status(503).json({ error: 'Webhook not configured' });
    return;
  }
  const provided = req.headers['x-developer-proxy-webhook-token'];
  if (typeof provided !== 'string') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

devProxyHookRouter.post(
  '/developer-proxy-hook',
  verifyDevProxyWebhookToken,
  async (req: Request, res: Response, next) => {
    try {
      const { event, tenantId, type, activeKeyCount } = req.body as {
        event?: string;
        tenantId?: string;
        type?: string;
        activeKeyCount?: number;
      };

      if (!tenantId || !type || !event) {
        return res.status(400).json({ error: 'event, tenantId, type required' });
      }
      if (type !== 'claude_code' && type !== 'codex') {
        return res.status(400).json({ error: 'type must be claude_code or codex' });
      }

      const count = typeof activeKeyCount === 'number' ? activeKeyCount : 0;
      await repo.upsert(tenantId, type, count);

      log.info({ event, tenantId, type, activeKeyCount: count }, 'developer-proxy-hook: integration synced');
      return res.json({ synced: true });
    } catch (err) {
      next(err);
    }
  },
);
