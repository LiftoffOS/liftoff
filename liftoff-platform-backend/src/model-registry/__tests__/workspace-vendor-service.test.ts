// setWorkspaceVendor / getWorkspaceVendor — the Workspace AI service functions.
// The critical property under test is the SINGLE-ROW INVARIANT: the repository
// upsert conflicts on (tenant_id, model_id), so a vendor change must reuse the
// existing row's model_id — writing a different model id would insert a second
// config row and make getModelForTask order-dependent.

import { jest } from '@jest/globals';

// In-memory model_configs store keyed (tenantId, modelId) — mirrors the real
// upsert's conflict target so a wrong-model-id write shows up as a second row.
type StoredConfig = {
  id: string; tenantId: string; modelId: string; version: number;
  routingPolicy: Record<string, unknown>; createdAt: Date; updatedAt: Date;
};
const store = new Map<string, StoredConfig>();
let idSeq = 0;

jest.mock('../repository', () => ({
  ModelRepository: jest.fn().mockImplementation(() => ({
    findByTierAndProvider: jest.fn(async (tier: string, provider: string) =>
      tier === 'medium' && provider === 'anthropic'
        ? { id: 'anchor-sonnet-row', modelId: 'claude-sonnet-4-6', provider: 'anthropic', tier: 'medium' }
        : null,
    ),
  })),
  ModelConfigRepository: jest.fn().mockImplementation(() => ({
    findByTenantId: jest.fn(async (tenantId: string) =>
      [...store.values()].filter((c) => c.tenantId === tenantId),
    ),
    upsert: jest.fn(async (tenantId: string, modelId: string, routingPolicy: Record<string, unknown>) => {
      const key = `${tenantId}:${modelId}`;
      const existing = store.get(key);
      const row: StoredConfig = existing
        ? { ...existing, routingPolicy, version: existing.version + 1, updatedAt: new Date() }
        : {
            id: `cfg-${++idSeq}`, tenantId, modelId, version: 1,
            routingPolicy, createdAt: new Date(), updatedAt: new Date(),
          };
      store.set(key, row);
      return row;
    }),
  })),
  ModelRolloutRepository: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../../events/publisher', () => ({ publishEvent: jest.fn(async () => undefined) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { ModelRegistryService } from '../service';
import { publishEvent } from '../../events/publisher';
import { WORKSPACE_AI_VENDORS } from '../workspace-ai-vendors';

const TENANT = '22222222-2222-2222-2222-222222222222';

describe('setWorkspaceVendor', () => {
  beforeEach(() => {
    store.clear();
    idSeq = 0;
    (publishEvent as jest.Mock).mockClear();
  });

  it('creates one row for a tenant with no config, anchored on the anthropic medium model', async () => {
    const service = new ModelRegistryService();
    const config = await service.setWorkspaceVendor(TENANT, 'qwen');
    expect(store.size).toBe(1);
    expect(config.modelId).toBe('anchor-sonnet-row');
    // The vendor's OWN provider. It stamped 'openrouter' for all four
    // open-weight vendors, which is the whole reason a workspace set to Qwen
    // ran GLM: the runtime resolves one adapter and one tier map per provider.
    expect(config.routingPolicy.defaultProvider).toBe('qwen');
    expect(config.routingPolicy.defaultTier).toBe('medium');
    // No resolved model id is stored. The `models` row this config is ANCHORED
    // on is a different thing from the model a call runs — the anchor satisfies
    // the table's foreign key, while the model is resolved from (provider, tier)
    // against the registry at call time. Conflating the two is what let a
    // workspace's policy name one generation while the registry named another.
    expect(config.routingPolicy.defaultModel).toBeUndefined();
    expect(publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'tenant.model_config.updated', tenantId: TENANT }),
    );
  });

  it('SINGLE-ROW INVARIANT: switching vendors repeatedly never adds a second row', async () => {
    const service = new ModelRegistryService();
    await service.setWorkspaceVendor(TENANT, 'qwen');
    await service.setWorkspaceVendor(TENANT, 'kimi');
    await service.setWorkspaceVendor(TENANT, 'google');
    await service.setWorkspaceVendor(TENANT, 'default');
    expect(store.size).toBe(1);
    const row = [...store.values()][0];
    expect(row.modelId).toBe('anchor-sonnet-row');
    // Last write wins: back on the platform-managed anthropic policy.
    expect(row.routingPolicy.defaultProvider).toBe('anthropic');
    expect(row.routingPolicy.selectedVendor).toBeUndefined();
  });

  it('re-stamp idempotence: applying the same selection twice yields an identical policy', async () => {
    const service = new ModelRegistryService();
    const first = await service.setWorkspaceVendor(TENANT, 'deepseek');
    const second = await service.setWorkspaceVendor(TENANT, 'deepseek');
    expect(second.routingPolicy).toEqual(first.routingPolicy);
    expect(store.size).toBe(1);
  });

  it('getWorkspaceVendor round-trips the marker and defaults to "default"', async () => {
    const service = new ModelRegistryService();
    expect(await service.getWorkspaceVendor(TENANT)).toBe('default');
    await service.setWorkspaceVendor(TENANT, 'glm');
    expect(await service.getWorkspaceVendor(TENANT)).toBe('glm');
    await service.setWorkspaceVendor(TENANT, 'default');
    expect(await service.getWorkspaceVendor(TENANT)).toBe('default');
  });
});
