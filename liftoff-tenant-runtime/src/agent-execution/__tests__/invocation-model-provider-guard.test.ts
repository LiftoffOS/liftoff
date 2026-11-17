// The workspace answers for the workspace's vendor, and an agent can be on
// another one.
//
// `resolveInvocationModelId` falls back to the workspace routing policy when an
// agent's config names no model. That is right for an agent running the
// workspace's vendor and wrong for one moved off it by the per-agent AI
// Provider Override: the policy's model belongs to a family this run is not on,
// and the id is handed to whichever adapter the agent's provider selected. A
// GLM agent in an Anthropic workspace asks the GLM adapter for a Claude id.
//
// Nothing downstream catches that. The provider decides the adapter and the
// model id is passed through as a string, so the request goes out to the right
// vendor with a name it has never heard of — a 404 at best, and at worst a
// silently different model where the two vocabularies happen to overlap.
//
// The guard is what makes it safe for the control plane to stop materialising a
// model id into a vendor override at all: without a stored id the fallback is
// the only resolution left, so it has to be right.

import { resolveModelForTier } from '../../llm/tiers';
import { resolveAgentModelId } from '../provider-resolution';

/** The real resolution, shared by executeTask (resolveInvocationModelId), the
 *  chat turn and the test harness. It used to be a mirror of the service's
 *  private method, which is how the chat turn and the harness each grew their
 *  own copy without the cross-vendor rule. */
function resolve(
  modelConfig: { modelId?: string; tier?: string } | undefined,
  provider: string,
  routed: { model: string; provider?: string } | null,
): string {
  return resolveAgentModelId(modelConfig, provider, routed);
}

describe('resolveInvocationModelId precedence', () => {
  it('honours an explicit pin above everything', () => {
    const got = resolve({ modelId: 'claude-opus-5' }, 'anthropic', { model: 'z-ai/glm-5.2', provider: 'glm' });
    expect(got).toBe('claude-opus-5');
  });

  it('takes the workspace model when the workspace is on this agent\'s vendor', () => {
    const got = resolve({ tier: 'medium' }, 'glm', { model: 'z-ai/glm-5-turbo', provider: 'glm' });
    expect(got).toBe('z-ai/glm-5-turbo');
  });

  it('REFUSES a workspace model belonging to another vendor', () => {
    // The per-agent override case: agent moved to GLM, workspace still
    // Anthropic. Taking `claude-sonnet-5` here sends a Claude id to the GLM
    // adapter.
    const got = resolve({ tier: 'medium' }, 'glm', { model: 'claude-sonnet-5', provider: 'anthropic' });
    expect(got).not.toBe('claude-sonnet-5');
    // Falls through to this provider's own tier table, which is the only
    // source that knows what 'medium' means for GLM.
    expect(got).toBe(resolveModelForTier('glm', 'medium'));
  });

  it('accepts a policy that names no provider, which cannot be crossed', () => {
    const got = resolve({ tier: 'medium' }, 'glm', { model: 'z-ai/glm-5-turbo' });
    expect(got).toBe('z-ai/glm-5-turbo');
  });

  it('resolves from provider + tier when there is no policy at all', () => {
    // The shape a per-agent override now produces: provider and tier, no id.
    for (const tier of ['large', 'medium', 'small'] as const) {
      expect(resolve({ tier }, 'glm', null)).toBe(resolveModelForTier('glm', tier));
    }
  });

  it('keeps each family on its own models', () => {
    // A tier means a different model per family; resolving without the
    // provider would collapse them onto whichever map answered.
    const glm = resolve({ tier: 'large' }, 'glm', null);
    const qwen = resolve({ tier: 'large' }, 'qwen', null);
    expect(glm).not.toBe(qwen);
  });

  it('a Qwen-overridden agent on a GLM workspace runs Qwen, at its own tier', () => {
    // The dev report: the workspace answered z-ai/glm-5.2 and the team, moved
    // to Qwen, coded on it while its session was billed as Qwen.
    const routed = { model: 'z-ai/glm-5.2', provider: 'glm' };
    expect(resolve({}, 'qwen', routed)).toBe('qwen/qwen3.7-plus');
    expect(resolve({ tier: 'large' }, 'qwen', routed)).toBe('qwen/qwen3.8-max-0902');
    // The retired tier name still means large.
    expect(resolve({ tier: 'flagship' }, 'qwen', routed)).toBe('qwen/qwen3.8-max-0902');
  });

  it('a pinned model still wins over a cross-vendor workspace', () => {
    const got = resolve({ modelId: 'qwen/qwen3.8-max-0902', tier: 'small' }, 'qwen', { model: 'z-ai/glm-5.2', provider: 'glm' });
    expect(got).toBe('qwen/qwen3.8-max-0902');
  });
});
