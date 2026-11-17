// A platform vendor lever only takes effect where its provider has a client.
//
// The defect this pins is the pair coming apart. The lever sets TWO things — a
// provider and, for a gateway vendor, the model, because each family has its
// own tier map and the provider alone would not say which model a tier means.
// If the provider is missing (no gateway key in this environment) and the model
// is applied anyway, the call falls through to Anthropic carrying a Qwen model
// id. What surfaces is a vendor rejecting a model that is not its, for what is
// really an unset key — and the lever reads as working on the admin screen.
//
// So: both or neither.

import type {
  LLMProviderClient,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamEvent,
} from '../types';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** What the provider was actually asked for. The assertion subject. */
let seen: { provider: string; model: string | undefined } | null = null;

class Recorder implements LLMProviderClient {
  constructor(readonly provider: 'openai' | 'openrouter') {}
  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    seen = { provider: this.provider, model: request.model };
    return { content: 'ok', model: request.model ?? 'default', provider: this.provider };
  }
  async *completeStream(): AsyncIterable<LLMStreamEvent> {
    // Not exercised here.
  }
}

/** OpenAI always present; the gateway present only when asked for. */
function mockProviders(withOpenRouter: boolean) {
  jest.doMock('../providers', () => ({
    AnthropicProvider: { create: jest.fn().mockResolvedValue(null), createPool: jest.fn().mockResolvedValue(null) },
    GoogleProvider: { create: jest.fn().mockResolvedValue(null) },
    OpenRouterProvider: {
      createOpenRouter: jest.fn().mockResolvedValue(withOpenRouter ? new Recorder('openrouter') : null),
    },
    OpenAIProvider: {
      create: jest.fn().mockImplementation(() => Promise.resolve(new Recorder('openai'))),
      createPool: jest.fn().mockImplementation(() => {
        const pool = new Map();
        const inst = new Recorder('openai');
        for (const g of ['agent-execution', 'reflective-services', 'platform-analytics', 'background-services']) {
          pool.set(g, inst);
        }
        return Promise.resolve(pool);
      }),
    },
  }));
}

beforeEach(() => {
  jest.resetModules();
  seen = null;
});

/** The quiet-work lever on Qwen, which is gateway-served. */
async function completeUnderTheQwenLever() {
  const policy = await import('../../model-registry/platform-vendor-policy');
  policy.setPlatformVendorPolicy({ quiet_work: 'qwen' });
  const { llmClient } = await import('../client');
  await llmClient.init();
  await llmClient.complete(
    { messages: [{ role: 'user', content: 'x' }], tier: 'small' },
    // No explicit provider — which is what 36 of the 37 callers pass, and the
    // only case the lever is allowed to touch.
    undefined,
    { purpose: 'thread_title_generation' },
  );
  policy._resetPlatformVendorPolicy();
}

describe('a gateway lever with no gateway client', () => {
  it('keeps the default provider AND drops the model with it', async () => {
    mockProviders(false);
    await completeUnderTheQwenLever();

    expect(seen?.provider).toBe('openai');
    // The half that matters: no Qwen model id arrived at OpenAI.
    expect(seen?.model).toBeUndefined();
  });
});

describe('a gateway lever with the gateway client present', () => {
  it('moves the call AND names the vendor\'s own model for the tier', async () => {
    mockProviders(true);
    const { WORKSPACE_AI_VENDORS } = await import('../../model-registry/workspace-ai-vendors');
    await completeUnderTheQwenLever();

    expect(seen?.provider).toBe('openrouter');
    // The tier is the CALLER's ('small'), resolved through Qwen's own ladder —
    // not the gateway client's tier map, which is GLM's.
    expect(seen?.model).toBe(WORKSPACE_AI_VENDORS.qwen.tiers.small);
  });
});

describe('the default changes nothing', () => {
  it('leaves the call on the platform default when no lever is set', async () => {
    mockProviders(true);
    const { llmClient } = await import('../client');
    await llmClient.init();
    await llmClient.complete(
      { messages: [{ role: 'user', content: 'x' }], tier: 'small' },
      undefined,
      { purpose: 'thread_title_generation' },
    );
    // OpenRouter is available and still not chosen: it is opt-in, never a
    // silent fallback, and 'default' means the pre-existing behaviour.
    expect(seen?.provider).toBe('openai');
    expect(seen?.model).toBeUndefined();
  });
});
