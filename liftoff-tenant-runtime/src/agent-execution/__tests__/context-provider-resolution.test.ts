// contextProvider / resolveAdapterModel — the invocation-level resolution must
// win over the agent-config read wherever the adapter's ACTUAL model/provider
// are chosen. Otherwise a Workspace-AI-routed workspace (entitlements
// defaultProvider=openrouter, defaultModel=qwen/...) builds the RIGHT adapter
// but hands it the agent-config fallbacks — the OpenRouter engine is invoked
// with an Anthropic model id and every run 400s ("... is not a valid model
// ID").

import { contextProvider, resolveAdapterModel } from '../service';
import { TIER_MODELS } from '../../llm/providers/anthropic';
import type { ExecutionContext } from '../types';

function ctx(partial: Partial<ExecutionContext>): ExecutionContext {
  return partial as ExecutionContext;
}

describe('contextProvider', () => {
  it('prefers the stamped invocation-level resolution over agent config', () => {
    expect(contextProvider(ctx({
      resolvedProvider: 'qwen',
      modelConfig: { provider: 'anthropic' } as ExecutionContext['modelConfig'],
    }))).toBe('qwen');
  });

  // The stamp can predate the control plane's migration 450, and the gateway's
  // name resolves to no tier map — so an untranslated one throws mid-run.
  it('translates a stamped gateway name', () => {
    expect(contextProvider(ctx({
      resolvedProvider: 'openrouter',
      modelConfig: { provider: 'anthropic' } as ExecutionContext['modelConfig'],
    }))).toBe('glm');
  });

  it('falls back to agent config for resume-rebuilt contexts (no stamp)', () => {
    expect(contextProvider(ctx({
      modelConfig: { provider: 'openai' } as ExecutionContext['modelConfig'],
    }))).toBe('openai');
  });

  it('returns undefined when neither exists (caller defaults apply)', () => {
    expect(contextProvider(ctx({ modelConfig: {} as ExecutionContext['modelConfig'] }))).toBeUndefined();
  });
});

describe('resolveAdapterModel', () => {
  it('prefers the stamped resolved model id (the E2E regression case)', () => {
    expect(resolveAdapterModel(ctx({
      resolvedProvider: 'openrouter',
      resolvedModelId: 'qwen/qwen3.7-plus',
      modelConfig: { tier: 'medium' } as ExecutionContext['modelConfig'],
    }))).toBe('qwen/qwen3.7-plus');
  });

  it('honors an explicit agent-config modelId when nothing is stamped', () => {
    expect(resolveAdapterModel(ctx({
      modelConfig: { modelId: 'claude-opus-5' } as ExecutionContext['modelConfig'],
    }))).toBe('claude-opus-5');
  });

  it('tier-resolves against the STAMPED provider, not the agent-config one', () => {
    // Stamped glm + tier medium must resolve in GLM's tier table, never the
    // anthropic one.
    expect(resolveAdapterModel(ctx({
      resolvedProvider: 'glm',
      modelConfig: { tier: 'medium' } as ExecutionContext['modelConfig'],
    }))).toBe('z-ai/glm-5.3');
  });

  // A context stamped before the control plane's migration 450 still names the
  // gateway. It resolves to no tier map, so an untranslated one throws out of
  // resolveModelForTier mid-run — and a resumed context can carry it for as
  // long as that run lives.
  it('translates a stamped gateway name to the family its model belongs to', () => {
    expect(resolveAdapterModel(ctx({
      resolvedProvider: 'openrouter',
      modelConfig: { tier: 'medium' } as ExecutionContext['modelConfig'],
    }))).toBe('z-ai/glm-5.3');

    expect(resolveAdapterModel(ctx({
      resolvedProvider: 'openrouter',
      modelConfig: { tier: 'medium', modelId: 'qwen/qwen3.7-plus' } as ExecutionContext['modelConfig'],
    }))).toBe('qwen/qwen3.7-plus');
  });

  it('falls back to the anthropic medium tier when nothing is known', () => {
    // Whatever the Anthropic medium tier currently is. The property under test
    // is that an unknown provider lands on Anthropic's medium tier rather than
    // throwing or picking another family's model, so it reads the tier map
    // instead of restating a model id that a tier move has to come back and
    // edit.
    expect(resolveAdapterModel(ctx({ modelConfig: { tier: 'medium' } as ExecutionContext['modelConfig'] })))
      .toBe(TIER_MODELS.medium);
  });
});
