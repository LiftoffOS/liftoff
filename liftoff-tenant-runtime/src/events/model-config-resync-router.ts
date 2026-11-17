// Operator-callable endpoint to force a model-config cache rebuild.
//
// Why this exists: the PB→TR sync of `cached_model_configs` rides on the
// `tenant.model_config.updated` Pub/Sub event. If the event was lost (Pub/Sub
// outage, subscription misconfiguration, handler crash, etc.) the TR cache
// silently drifts: a stale row can keep routing calls to the wrong provider
// or model (e.g. embedding calls sent to a chat model and rejected with
// "You are not allowed to generate embeddings from this model") while PB
// carries the canonical config.
//
// This endpoint synthesizes the `tenant.model_config.updated` event locally
// and dispatches it through the same handler the Pub/Sub subscriber uses.
// The handler fetches PB's `/api/internal/model-registry/tenant/{tenantId}/configs`,
// DELETEs the cached row(s), and INSERTs fresh ones — bringing TR in lock
// step with PB regardless of upstream event-publishing health.
//
// Auth: X-Service-Auth bearer (TENANT_RUNTIME_SERVICE_TOKEN). Same pattern
// as the existing /api/internal/event-status endpoint (ADR-018) so the same
// rotation lifecycle applies.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireServiceAuth } from '../security/service-auth';
import { handleModelConfigUpdated } from './subscriber';
import { getEntitlementsClient } from '../entitlements-client/service';
import { logger } from '../infrastructure/logging';
import type { ControlPlaneEvent } from './types';
import { randomUUID } from 'crypto';

export const modelConfigResyncRouter = Router();
// `requireServiceAuth` from src/security, NOT `verifyServiceAuth` from
// @liftoffos/service-client. The package's verifier resolves the expected
// token with `process.env[tokenEnvVar]` and answers 500 when it finds
// nothing — and this runtime no longer keeps secrets in the environment
// (INV-TR-016). Every request to this router returned 500 until it moved.
// Same default semantics: shared bearer only, TENANT_RUNTIME_SERVICE_TOKEN,
// constant-time compare.
const svcAuth = requireServiceAuth();

const paramSchema = z.object({ tenant_id: z.string().uuid() });

// Operator diagnostic: what does THIS runtime actually resolve for the tenant,
// through the exact entitlements-client path executeTask uses? Surfaces cache
// visibility + the per-task resolution in one call, so a "workspace vendor not
// taking effect" report is a curl, not a DB spelunk. Same auth as resync.
modelConfigResyncRouter.get(
  '/model-configs/:tenant_id/resolution',
  svcAuth,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = paramSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_tenant_id' });
      return;
    }
    const tenantId = parsed.data.tenant_id;
    try {
      const client = getEntitlementsClient();
      const configs = await client.getModelConfigs(tenantId);
      const agentExecution = await client.getModelForTask(tenantId, 'agent_execution');
      res.json({
        tenantId,
        configsCount: configs.length,
        configs: configs.map((c) => ({
          modelId: c.modelId,
          defaultProvider: c.routingPolicy?.defaultProvider,
          defaultModel: c.routingPolicy?.defaultModel,
          selectedVendor: (c.routingPolicy as { selectedVendor?: string } | undefined)?.selectedVendor,
          routingPolicyKeys: Object.keys(c.routingPolicy ?? {}),
        })),
        agentExecution,
      });
    } catch (err) {
      logger.error({ tenantId, err: (err as Error).message }, 'model_config_resolution_probe_failed');
      res.status(500).json({ error: 'resolution_probe_failed', message: (err as Error).message });
    }
  },
);

modelConfigResyncRouter.post(
  '/model-configs/resync/:tenant_id',
  svcAuth,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = paramSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_tenant_id' });
      return;
    }
    const tenantId = parsed.data.tenant_id;

    // Build a synthetic event that the existing handler will accept. The
    // handler ignores entity_id / entity_version for tenant.model_config.*
    // (it fetches the FULL config list from PB on every event, by tenantId),
    // so any non-null UUIDs suffice. Marker `manual_resync=true` makes the
    // origin obvious in audit logs.
    const event: ControlPlaneEvent = {
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      entity_type: 'model_config',
      entity_id: randomUUID(),
      entity_version: 0,
      event_type: 'tenant.model_config.updated',
      event_version: 1,
      tenant_id: tenantId,
      payload: { manual_resync: true },
    };

    try {
      await handleModelConfigUpdated(event);
      logger.info({ tenantId }, 'model_config_cache_resync_completed');
      res.json({ status: 'resynced', tenant_id: tenantId });
    } catch (err) {
      logger.error(
        { tenantId, err: (err as Error).message },
        'model_config_cache_resync_failed',
      );
      res.status(500).json({ error: 'resync_failed', message: (err as Error).message });
    }
  },
);
