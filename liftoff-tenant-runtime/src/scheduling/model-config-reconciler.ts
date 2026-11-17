// Periodic reconciler for cached_model_configs.
//
// Defense-in-depth against a known failure mode: migrations
// that mutate model_configs in PB without firing
// tenant.model_config.updated events silently drift every TR's cache
// from PB's authoritative routing_policy. The manual
// /api/internal/model-configs/resync/:tenant_id escape hatch (and the
// PB-side outbox trigger in migration 263) narrow that, but neither covers
// a cache that had ALREADY drifted before they were in place.
//
// This reconciler walks every tenant in cached_model_configs and asks
// PB for the canonical configs, refreshing the cache via the same
// handler the Pub/Sub subscriber uses. Wired to Cloud Scheduler at
// hourly cadence (separate Terraform / scheduler entry).
//
// One bad tenant does not block others — per-tenant errors are caught
// and counted.

import { subscriberPool } from '../events/subscriber';
import { handleModelConfigUpdated } from '../events/subscriber';
import { logger } from '../infrastructure/logging';
import { randomUUID } from 'crypto';
import type { ControlPlaneEvent } from '../events/types';

export interface ReconcileResult {
  tenantCount: number;
  reconciled: number;
  failed: number;
  errors: Array<{ tenantId: string; err: string }>;
  durationMs: number;
}

export async function reconcileModelConfigs(): Promise<ReconcileResult> {
  const start = Date.now();
  const tenantIds = await listCachedTenants();
  const errors: ReconcileResult['errors'] = [];
  let reconciled = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      const syntheticEvent: ControlPlaneEvent = {
        event_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        entity_type: 'model_config',
        entity_id: randomUUID(),
        entity_version: 0,
        event_type: 'tenant.model_config.updated',
        event_version: 1,
        tenant_id: tenantId,
        payload: { reconciler: true },
      };
      await handleModelConfigUpdated(syntheticEvent);
      reconciled += 1;
    } catch (err) {
      failed += 1;
      const message = (err as Error).message;
      errors.push({ tenantId, err: message });
      logger.warn(
        { tenantId, err: message },
        'model-config-reconciler: tenant refresh failed (continuing)',
      );
    }
  }

  const durationMs = Date.now() - start;
  logger.info(
    { tenantCount: tenantIds.length, reconciled, failed, durationMs },
    'model-config-reconciler: cycle complete',
  );

  return { tenantCount: tenantIds.length, reconciled, failed, errors, durationMs };
}

async function listCachedTenants(): Promise<string[]> {
  const r = await subscriberPool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id::text AS tenant_id FROM cached_model_configs`,
  );
  return r.rows.map(row => row.tenant_id);
}
