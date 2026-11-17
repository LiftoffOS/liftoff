// The per-agent AI Provider Override records a PROVIDER, never a model id.
//
// The dropdown offers a vendor. Which model that vendor's tier means is the
// runtime's to resolve, from the registry, at the moment it runs — so writing a
// resolved id here is wrong twice over.
//
// It froze the answer: a registry change reached an agent only when somebody
// next edited that agent.
//
// And it was indistinguishable from a deliberate model pin. `code_session`
// reads `model_config.modelId` as exactly that, and it outranks the vendor's
// coding model — so choosing a vendor silently pinned the CODING model to the
// agent's chat tier. Observed live: an agent overridden to GLM ran its coding
// session on `z-ai/glm-5-turbo`, the medium chat model, instead of GLM's coding
// large-tier model. The convention every coding runner implements — each vendor
// codes with its own large-tier model — never applied to an agent that had used the dropdown.

import {
  effectiveModelConfig,
  WORKSPACE_AI_VENDORS,
  type WorkspaceAiSelection,
} from '../workspace-ai-vendors';

describe('effectiveModelConfig', () => {
  it('stamps provider and tier, and NO model id', () => {
    const out = effectiveModelConfig({
      modelConfig: { tier: 'medium' },
      aiVendorOverride: 'glm',
    });
    expect(out.provider).toBe(WORKSPACE_AI_VENDORS.glm.provider);
    expect(out.tier).toBe('medium');
    expect(out.modelId).toBeUndefined();
  });

  it('never emits a model id for ANY vendor', () => {
    // Enumerated rather than sampled: one vendor keeping the old shape is one
    // vendor whose coding sessions stay pinned to the chat tier.
    for (const vendor of Object.keys(WORKSPACE_AI_VENDORS) as WorkspaceAiSelection[]) {
      const out = effectiveModelConfig({ modelConfig: { tier: 'large' }, aiVendorOverride: vendor });
      expect(out.modelId).toBeUndefined();
      expect(out.provider).toBeTruthy();
    }
  });

  it('preserves the agent\'s own tier rather than resetting it', () => {
    // Choosing a vendor is not choosing a size.
    for (const tier of ['large', 'medium', 'small'] as const) {
      expect(effectiveModelConfig({ modelConfig: { tier }, aiVendorOverride: 'qwen' }).tier).toBe(tier);
    }
  });

  it('leaves an admin pin untouched', () => {
    // An explicit modelId is a real routing decision and the dropdown must not
    // overwrite it.
    const pinned = { tier: 'medium' as const, modelId: 'claude-opus-5', provider: 'anthropic' };
    expect(effectiveModelConfig({ modelConfig: pinned, aiVendorOverride: 'glm' })).toEqual(pinned);
  });

  it('leaves a config with no override untouched', () => {
    const plain = { tier: 'medium' as const };
    expect(effectiveModelConfig({ modelConfig: plain, aiVendorOverride: null })).toEqual(plain);
  });

  it('routes Liftoff Managed through the same mapping', () => {
    const out = effectiveModelConfig({ modelConfig: { tier: 'medium' }, aiVendorOverride: 'default' });
    expect(out.modelId).toBeUndefined();
    expect(out.provider).toBeTruthy();
  });
});
