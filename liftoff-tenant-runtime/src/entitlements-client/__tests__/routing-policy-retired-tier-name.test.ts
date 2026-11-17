// The cached routing policy is the control plane's, stored verbatim, so until it
// refreshes it can name the top tier by its retired name ('flagship'; 'large'
// now). The repository normalises the policy's tier intent on read. Without
// that, the tier table does not recognise the name and quietly answers with the
// MEDIUM model: a large-tier task would be downgraded with no error anywhere.
//
// Driven through the real repository (only the pool is faked), because the
// read boundary is the property under test.

import { EntitlementsClient } from '../service';

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: mockQuery }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function policyWithTopTierNamed(name: string) {
  return {
    defaultTier: name,
    defaultModel: 'claude-sonnet-4-6',
    defaultProvider: 'anthropic',
    // A model-only task override keeps its tier intent and takes the model
    // the provider publishes for that tier (taskSpecificPair).
    taskOverrides: { retrieval_hyde: 'claude-haiku-4-5-20251001' },
    taskTierOverrides: { retrieval_hyde: name },
  };
}

function cacheHolds(routingPolicy: unknown, asText = false) {
  mockQuery.mockResolvedValue({
    rows: [{
      id: 'c1', tenant_id: 't1', model_id: 'm',
      routing_policy: asText ? JSON.stringify(routingPolicy) : routingPolicy,
      version: 1, entity_version: 1,
    }],
  });
}

beforeEach(() => mockQuery.mockReset());

describe('a cached routing policy under the retired top-tier name', () => {
  it('reads back under the current name', async () => {
    cacheHolds(policyWithTopTierNamed('flagship'));
    const [config] = await new EntitlementsClient().getModelConfigs('t1');
    expect(config.routingPolicy.defaultTier).toBe('large');
    expect(config.routingPolicy.taskTierOverrides).toEqual({ retrieval_hyde: 'large' });
  });

  it('reads back under the current name when stored as text', async () => {
    cacheHolds(policyWithTopTierNamed('flagship'), true);
    const [config] = await new EntitlementsClient().getModelConfigs('t1');
    expect(config.routingPolicy.defaultTier).toBe('large');
  });

  it('resolves the same model as the same policy saying large', async () => {
    cacheHolds(policyWithTopTierNamed('large'));
    const underLarge = await new EntitlementsClient().getModelForTask('t1', 'retrieval_hyde');
    cacheHolds(policyWithTopTierNamed('flagship'));
    const underRetired = await new EntitlementsClient().getModelForTask('t1', 'retrieval_hyde');

    expect(underLarge).toEqual({ model: 'claude-opus-5-5', provider: 'anthropic' });
    expect(underRetired).toEqual(underLarge);
  });

  it('treats an agent asking for large as matching a default tier under the retired name', async () => {
    // Equal tiers mean the hint changes nothing and the policy's own default
    // pair answers, exactly as it does for a policy already saying 'large'.
    cacheHolds(policyWithTopTierNamed('flagship'));
    await expect(new EntitlementsClient().getModelForTask('t1', 'agent_execution', 'large'))
      .resolves.toEqual({ model: 'claude-sonnet-4-6', provider: 'anthropic' });
  });

  it('leaves the other tiers, and a policy with no tier intent, as they are', async () => {
    cacheHolds({ defaultTier: 'small', taskTierOverrides: { x: 'medium' }, defaultModel: 'm' });
    const [withTiers] = await new EntitlementsClient().getModelConfigs('t1');
    expect(withTiers.routingPolicy).toEqual({ defaultTier: 'small', taskTierOverrides: { x: 'medium' }, defaultModel: 'm' });

    cacheHolds({ defaultModel: 'm' });
    const [bare] = await new EntitlementsClient().getModelConfigs('t1');
    expect(bare.routingPolicy).toEqual({ defaultModel: 'm' });
  });
});
