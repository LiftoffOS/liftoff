// Feature Flag Service Implementation
// Per Section 4: Tenant runtime may pull feature flags

import { FeatureFlag, CreateFlagInput, UpdateFlagInput } from './types';
import { FeatureFlagRepository } from './repository';
import { publishEvent, mutateAndPublishEvent } from '../events/publisher';

export class FeatureFlagService {
  private repository = new FeatureFlagRepository();

  async list(): Promise<FeatureFlag[]> {
    return this.repository.findAll();
  }

  async getById(id: string): Promise<FeatureFlag | null> {
    return this.repository.findById(id);
  }

  async getByKey(key: string): Promise<FeatureFlag | null> {
    return this.repository.findByKey(key);
  }

  // Per Section 4: Tenant runtime may pull feature flags
  async getForTenant(tenantId: string): Promise<Record<string, boolean>> {
    const flags = await this.repository.findAll();

    const evaluated: Record<string, boolean> = {};
    for (const flag of flags) {
      // Check tenant-specific override first, then fall back to default
      if (flag.tenantOverrides && tenantId in flag.tenantOverrides) {
        evaluated[flag.key] = flag.tenantOverrides[tenantId];
      } else {
        evaluated[flag.key] = flag.enabled;
      }
    }

    return evaluated;
  }

  // Check if a specific flag is enabled for a tenant
  async isEnabled(key: string, tenantId?: string): Promise<boolean> {
    const flag = await this.repository.findByKey(key);
    if (!flag) {
      return false;
    }

    if (tenantId && flag.tenantOverrides && tenantId in flag.tenantOverrides) {
      return flag.tenantOverrides[tenantId];
    }

    return flag.enabled;
  }

  async create(input: CreateFlagInput): Promise<FeatureFlag> {
    const flag = await this.repository.create(input);

    // Per Section 4: Publish feature flag created event
    await publishEvent({
      eventType: 'tenant.feature_flag.created',
      entityType: 'feature_flag',
      entityId: flag.id,
      entityVersion: 1,
      eventVersion: 1,
      payload: {
        key: flag.key,
        enabled: flag.enabled,
        ...(flag.valueNum !== null ? { value_num: flag.valueNum } : {}),
      },
    });

    return flag;
  }

  async update(id: string, input: UpdateFlagInput): Promise<FeatureFlag> {
    const flag = await this.repository.update(id, input);

    // Per Section 4: Publish feature flag updated event
    await publishEvent({
      eventType: 'tenant.feature_flag.updated',
      entityType: 'feature_flag',
      entityId: flag.id,
      entityVersion: 1,
      eventVersion: 1,
      payload: {
        key: flag.key,
        enabled: flag.enabled,
        ...(flag.valueNum !== null ? { value_num: flag.valueNum } : {}),
      },
    });

    return flag;
  }

  async delete(id: string): Promise<void> {
    // Look up the key BEFORE deletion so we can include it on the event.
    // The runtime needs the key to drop it from the sentinel row's flags JSONB.
    const existing = await this.repository.findById(id);
    if (!existing) throw new Error(`Feature flag not found: ${id}`);
    await this.repository.delete(id);
    await publishEvent({
      eventType: 'tenant.feature_flag.deleted',
      entityType: 'feature_flag',
      entityId: id,
      entityVersion: 1,
      eventVersion: 1,
      payload: { key: existing.key },
    });
  }

  // Set tenant-specific override.
  //
  // Atomic mutation + tenant-scoped event in ONE transaction (mutateAndPublishEvent),
  // so the row and the outbox row commit together — the event is the ONLY refresh
  // signal for TR's per-tenant flag cache (there is no control-plane refresh TTL on
  // that row), and losing it would leave running tenants stale. The event carries
  // `tenantId` (so TR's branch-2 refetches this tenant) and payload `{ key }` with
  // NO `enabled` (so TR's global-sentinel mirror in branch-1 is skipped — an override
  // must not overwrite the global default).
  async setTenantOverride(
    flagKey: string,
    tenantId: string,
    enabled: boolean
  ): Promise<FeatureFlag> {
    return mutateAndPublishEvent(
      { caller: 'FeatureFlagService.setTenantOverride', reason: 'set tenant feature-flag override' },
      async (client) => {
        const flag = await this.repository.setTenantOverrideInTx(client, flagKey, tenantId, enabled);
        if (!flag) throw new Error(`Feature flag not found: ${flagKey}`);
        return {
          entity: flag,
          eventInput: {
            eventType: 'tenant.feature_flag.updated',
            entityType: 'feature_flag',
            entityId: flag.id,
            entityVersion: 1,
            eventVersion: 1,
            tenantId,
            payload: { key: flag.key },
          },
        };
      },
    );
  }

  // Remove tenant-specific override (same atomic mutation + tenant-scoped event).
  async removeTenantOverride(flagKey: string, tenantId: string): Promise<FeatureFlag> {
    return mutateAndPublishEvent(
      { caller: 'FeatureFlagService.removeTenantOverride', reason: 'remove tenant feature-flag override' },
      async (client) => {
        const flag = await this.repository.removeTenantOverrideInTx(client, flagKey, tenantId);
        if (!flag) throw new Error(`Feature flag not found: ${flagKey}`);
        return {
          entity: flag,
          eventInput: {
            eventType: 'tenant.feature_flag.updated',
            entityType: 'feature_flag',
            entityId: flag.id,
            entityVersion: 1,
            eventVersion: 1,
            tenantId,
            payload: { key: flag.key },
          },
        };
      },
    );
  }
}
