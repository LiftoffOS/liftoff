// A per-agent tier has to mean something.
//
// The workspace policy's `defaultModel` was consulted BEFORE the provider tier
// table, so it answered every caller: an agent configured for 'large' was
// served the workspace default and ran the medium model, with no error
// anywhere. The tier hint fixes the order of authority without breaking the
// workspace's: the workspace still picks the provider and the model family, the
// agent picks the size, and the model/provider pair stays coherent.
//
// Also covers getTaskModelOverride, which exists precisely BECAUSE
// getModelForTask falls back to the default pair. Callers that must know
// whether anyone actually pinned a model for a task cannot use a lookup that
// always answers something.

import { EntitlementsClient } from '../service';
import type { ModelConfig } from '../types';

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Policy = Record<string, unknown>;

function serviceWithPolicy(routingPolicy: Policy): EntitlementsClient {
  const svc = new EntitlementsClient();
  jest.spyOn(svc, 'getModelConfigs').mockResolvedValue([{ routingPolicy } as unknown as ModelConfig]);
  return svc;
}

/** The shape every live tenant actually carries today. */
const PROD_POLICY: Policy = {
  defaultTier: 'medium',
  defaultModel: 'claude-sonnet-4-6',
  defaultProvider: 'anthropic',
  taskOverrides: { retrieval_hyde: 'claude-haiku-4-5-20251001' },
  taskTierOverrides: { retrieval_hyde: 'small' },
};

describe('getModelForTask tier hint', () => {
  it('changes NOTHING for the default tier agents carry', async () => {
    // Agents normally carry {tier:'medium'} and every policy's
    // defaultTier is 'medium'. This must stay a no-op, or the fix ships as a
    // silent fleet-wide model change.
    const svc = serviceWithPolicy(PROD_POLICY);
    await expect(svc.getModelForTask('t1', 'agent_execution', 'medium'))
      .resolves.toEqual({ model: 'claude-sonnet-4-6', provider: 'anthropic' });
  });

  it('is identical with no hint at all', async () => {
    const svc = serviceWithPolicy(PROD_POLICY);
    await expect(svc.getModelForTask('t1', 'agent_execution'))
      .resolves.toEqual({ model: 'claude-sonnet-4-6', provider: 'anthropic' });
  });

  it('serves the large model to an agent that asked for large', async () => {
    // The whole point: this used to return claude-sonnet-4-6.
    const svc = serviceWithPolicy(PROD_POLICY);
    await expect(svc.getModelForTask('t1', 'agent_execution', 'large'))
      .resolves.toEqual({ model: 'claude-opus-5-5', provider: 'anthropic' });
  });

  it('serves the small model to an agent that asked for small', async () => {
    const svc = serviceWithPolicy(PROD_POLICY);
    await expect(svc.getModelForTask('t1', 'agent_execution', 'small'))
      .resolves.toEqual({ model: 'claude-haiku-4-5', provider: 'anthropic' });
  });

  it('resolves the tier against the WORKSPACE provider, never another vendor', async () => {
    // The tier picks the size; the workspace still picks the vendor. Resolving
    // a tier against the wrong provider is how a Claude id reaches another
    // vendor's endpoint.
    const svc = serviceWithPolicy({
      defaultTier: 'medium',
      defaultModel: 'z-ai/glm-5-turbo',
      defaultProvider: 'glm',
    });
    const resolved = await svc.getModelForTask('t1', 'agent_execution', 'large');
    expect(resolved).toEqual({ model: 'z-ai/glm-5.3', provider: 'glm' });
    expect(resolved!.model).not.toMatch(/^claude-/);
  });

  it('leaves a task-specific override untouched — it outranks the hint', async () => {
    const svc = serviceWithPolicy(PROD_POLICY);
    await expect(svc.getModelForTask('t1', 'retrieval_hyde', 'large'))
      .resolves.toEqual({ model: 'claude-haiku-4-5', provider: 'anthropic' });
  });

  it('falls back to the default pair when the policy names no provider', async () => {
    // No provider means no catalogue to resolve a tier against, so the hint
    // cannot be honoured and the default stands rather than guessing a vendor.
    const svc = serviceWithPolicy({ defaultTier: 'medium', defaultModel: 'some-model' });
    await expect(svc.getModelForTask('t1', 'agent_execution', 'large'))
      .resolves.toEqual({ model: 'some-model', provider: undefined });
  });
});

describe('getTaskModelOverride', () => {
  it('returns null when the task carries no pin, even though a default exists', async () => {
    // The distinction the coding runners depend on: "nobody chose a model for
    // this task" must not come back as the workspace default, or every nested
    // coding agent silently loses its own default model.
    const svc = serviceWithPolicy(PROD_POLICY);
    await expect(svc.getTaskModelOverride('t1', 'code_session')).resolves.toBeNull();
  });

  it('returns a complete pin written for the task', async () => {
    const svc = serviceWithPolicy({
      ...PROD_POLICY,
      taskOverrides: { code_session: 'claude-opus-5' },
      providerOverrides: { code_session: 'anthropic' },
    });
    await expect(svc.getTaskModelOverride('t1', 'code_session'))
      .resolves.toEqual({ model: 'claude-opus-5', provider: 'anthropic' });
  });

  it('applies the same pairing rules as getModelForTask to a half-written pin', async () => {
    const svc = serviceWithPolicy({
      defaultTier: 'medium',
      defaultModel: 'z-ai/glm-5-turbo',
      defaultProvider: 'glm',
      // A Claude id left over from when the workspace ran on Anthropic.
      taskOverrides: { code_session: 'claude-sonnet-4-6' },
    });
    const pin = await svc.getTaskModelOverride('t1', 'code_session');
    expect(pin!.provider).toBe('glm');
    expect(pin!.model).not.toMatch(/^claude-/);
  });
});
