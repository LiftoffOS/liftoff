// A task's model and its provider must be resolved as ONE pair.
//
// The two halves used to be resolved independently — the model from
// `taskOverrides[task] || defaultModel`, the provider from
// `providerOverrides[task] || defaultProvider`. A task that carried a model
// override with no provider override (the legacy shape: those rows were
// written while every workspace ran on Anthropic) then inherited TODAY's
// default provider. On a workspace switched to a Qwen/GLM/DeepSeek vendor
// that shipped `claude-sonnet-4-6` to OpenRouter, which answered
// `400 claude-sonnet-4-6 is not a valid model ID` and failed the task.

import { EntitlementsClient } from '../service';
import { TIER_MODELS as ANTHROPIC_TIERS } from '../../llm/providers/anthropic';
import { TIER_MODELS as QWEN_TIERS } from '../../llm/providers/qwen';
import type { ModelConfig } from '../types';

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Policy = Record<string, unknown>;

/** A client whose only stubbed surface is the policy lookup — the pairing
 *  logic under test is the real implementation. */
function serviceWithPolicy(routingPolicy: Policy): EntitlementsClient {
  const svc = new EntitlementsClient();
  jest.spyOn(svc, 'getModelConfigs').mockResolvedValue([{ routingPolicy } as unknown as ModelConfig]);
  return svc;
}

describe('getModelForTask keeps model and provider on the same side', () => {
  it('uses a COMPLETE task override verbatim', async () => {
    const svc = serviceWithPolicy({
      defaultProvider: 'qwen',
      defaultModel: 'qwen/qwen3.7-plus',
      taskOverrides: { retrieval_hyde: 'claude-haiku-4-5' },
      providerOverrides: { retrieval_hyde: 'anthropic' },
    });
    // Both halves were written together, so they are trusted together — this
    // is how a platform-managed background task deliberately stays on
    // Anthropic while the workspace runs on another vendor.
    await expect(svc.getModelForTask('t1', 'retrieval_hyde'))
      .resolves.toEqual({ model: 'claude-haiku-4-5', provider: 'anthropic' });
  });

  it('never pairs a legacy model-only override with a different vendor', async () => {
    const svc = serviceWithPolicy({
      defaultProvider: 'qwen',
      defaultModel: 'qwen/qwen3.7-plus',
      defaultTier: 'medium',
      // Written when the workspace was still on Anthropic; no provider half.
      taskOverrides: { retrieval_hyde: 'claude-sonnet-4-6' },
      taskTierOverrides: { retrieval_hyde: 'small' },
    });
    const resolved = await svc.getModelForTask('t1', 'retrieval_hyde');
    expect(resolved!.provider).toBe('qwen');
    // The exact regression: a Claude id must never be handed to another vendor.
    expect(resolved!.model).not.toBe('claude-sonnet-4-6');
    expect(resolved!.model).not.toMatch(/^claude-/);
  });

  it('preserves the tier intent of a model-only override', async () => {
    const svc = serviceWithPolicy({
      defaultProvider: 'glm',
      defaultModel: 'z-ai/glm-5-turbo',
      defaultTier: 'medium',
      taskOverrides: { retrieval_hyde: 'claude-haiku-4-5' },
      taskTierOverrides: { retrieval_hyde: 'small' },
    });
    const resolved = await svc.getModelForTask('t1', 'retrieval_hyde');
    // A task pinned to the cheap tier stays cheap — it resolves to the SMALL
    // model of the effective provider, not to that provider's default medium.
    const { modelForTierOrUndefined } = await import('../../llm/tiers');
    expect(resolved!.model).toBe(modelForTierOrUndefined('glm', 'small'));
  });

  it('falls back to the default PAIR when the provider has no catalogue', async () => {
    const svc = serviceWithPolicy({
      defaultProvider: 'some-future-vendor',
      defaultModel: 'future/model-1',
      defaultTier: 'medium',
      taskOverrides: { retrieval_hyde: 'claude-sonnet-4-6' },
    });
    // We cannot translate the tier for an unknown provider, so we fall back to
    // the one pair we know is coherent rather than shipping a foreign id.
    await expect(svc.getModelForTask('t1', 'retrieval_hyde'))
      .resolves.toEqual({ model: 'future/model-1', provider: 'some-future-vendor' });
  });

  it('uses the default pair when the task has no override at all', async () => {
    const svc = serviceWithPolicy({
      defaultProvider: 'qwen',
      defaultModel: 'qwen/qwen3.7-plus',
    });
    await expect(svc.getModelForTask('t1', 'unassigned_task'))
      .resolves.toEqual({ model: 'qwen/qwen3.7-plus', provider: 'qwen' });
  });

  it('is unchanged for an all-Anthropic workspace', async () => {
    const svc = serviceWithPolicy({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      defaultTier: 'medium',
      taskOverrides: { retrieval_hyde: 'claude-haiku-4-5' },
      providerOverrides: { retrieval_hyde: 'anthropic' },
    });
    await expect(svc.getModelForTask('t1', 'retrieval_hyde'))
      .resolves.toEqual({ model: 'claude-haiku-4-5', provider: 'anthropic' });
  });

  it('honours a model override when the policy names no provider at all', async () => {
    // Older policies carry neither a default nor a per-task provider. There is
    // no boundary to cross — the adapter picks its own default — so the
    // override stands. Tightening this would silently downgrade every
    // pre-vendor-selection tenant's per-task models to the policy default.
    const svc = serviceWithPolicy({
      defaultModel: 'claude-3-opus',
      taskOverrides: { summarization: 'claude-3-sonnet' },
    });
    await expect(svc.getModelForTask('t1', 'summarization'))
      .resolves.toEqual({ model: 'claude-3-sonnet', provider: undefined });
  });

  it('resolves the provider’s own tier when the policy names no model at all', async () => {
    // This used to answer null, and that was right while a policy was expected
    // to carry a resolved model id. It no longer is: the control plane stopped
    // materialising one, so a policy that names a provider and nothing else is
    // the NORMAL shape and null would strand every caller.
    //
    // The pairing property this file exists for is unchanged and is the point of
    // the assertion — the model comes from the named provider's own catalogue,
    // so the two halves still cannot be crossed.
    const svc = serviceWithPolicy({ defaultProvider: 'anthropic' });

    await expect(svc.getModelForTask('t1', 'retrieval_hyde'))
      .resolves.toEqual({ model: ANTHROPIC_TIERS.medium, provider: 'anthropic' });
  });

  it('resolves a provider-only policy for a NON-Anthropic vendor from that vendor', async () => {
    // The crossing this file is named after, in the shape the new resolution
    // could reintroduce: a Qwen workspace carrying no model id must not be
    // answered from the Anthropic table.
    const svc = serviceWithPolicy({ defaultProvider: 'qwen' });

    const pair = await svc.getModelForTask('t1', 'retrieval_hyde');

    expect(pair?.provider).toBe('qwen');
    expect(pair?.model).toBe(QWEN_TIERS.medium);
    expect(pair?.model).not.toMatch(/^claude-/);
  });

  it('keeps a task on ITS assigned tier when the task carries no model id', async () => {
    // The five background tasks are assigned `small` and written as a tier plus
    // a provider with no model. Falling through to the workspace default would
    // run every one of them a tier up, at a tier up's price, and nothing would
    // report it.
    const svc = serviceWithPolicy({
      defaultProvider: 'anthropic',
      defaultTier: 'medium',
      taskTierOverrides: { retrieval_hyde: 'small' },
      providerOverrides: { retrieval_hyde: 'anthropic' },
    });

    await expect(svc.getModelForTask('t1', 'retrieval_hyde'))
      .resolves.toEqual({ model: ANTHROPIC_TIERS.small, provider: 'anthropic' });
  });

  it('keeps a task on its assigned PROVIDER when that differs from the workspace', async () => {
    // Embedding is assigned to Google whatever the workspace runs on. With no
    // model id written, the provider half is what carries that, and reading the
    // workspace default instead would send an embedding call to the wrong vendor.
    const svc = serviceWithPolicy({
      defaultProvider: 'anthropic',
      defaultTier: 'medium',
      taskTierOverrides: { tabular_extract: 'small' },
      providerOverrides: { tabular_extract: 'google' },
    });

    const pair = await svc.getModelForTask('t1', 'tabular_extract');

    expect(pair?.provider).toBe('google');
    expect(pair?.model).not.toMatch(/^claude-/);
  });
});

// The cached policy can still name the gateway after the control plane has
// moved off it — a cache is only as current as its last refresh. Untranslated,
// 'openrouter' resolves to no tier map, so the tier intent is silently dropped
// and the workspace falls back to whatever model happened to be pinned.
describe('a cached policy still naming the gateway', () => {
  it('resolves to the family its default model belongs to', async () => {
    const svc = serviceWithPolicy({
      defaultProvider: 'openrouter',
      defaultModel: 'qwen/qwen3.7-plus',
      defaultTier: 'medium',
      taskOverrides: { retrieval_hyde: 'claude-sonnet-4-6' },
      taskTierOverrides: { retrieval_hyde: 'small' },
    });
    const resolved = await svc.getModelForTask('t1', 'retrieval_hyde');
    // Qwen, not GLM. The Claude id names no publisher, so reading the TASK's
    // model against the workspace provider would have answered with the
    // gateway's old default and put a Qwen workspace on GLM.
    expect(resolved!.provider).toBe('qwen');
    expect(resolved!.model).toMatch(/^qwen\//);
  });
});
