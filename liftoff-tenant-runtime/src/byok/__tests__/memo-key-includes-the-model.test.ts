// The BYOK memo is keyed by the model too, because for one provider the
// funding answer depends on it.
//
// `openrouter` fronts five vendors — GLM, Qwen, DeepSeek, Kimi and Grok — and
// exactly one of them can be funded by a customer key. An OpenRouter invoice is
// Liftoff's, so the other four always resolve to managed; Grok has an xAI key
// that pays xAI directly, which is why it re-routes off OpenRouter entirely.
//
// Keyed on the provider alone, those two answers collide inside one invocation
// and whichever call ran first decides for both. Either the Grok turn silently
// loses the customer's funding — the run succeeds, Liftoff pays, and nothing
// says so — or a GLM turn is handed an xAI credential, which is worse.
//
// The memo itself is right: the decision is per (run, provider, model, purpose)
// and re-asking the control plane on every step would put a network round trip
// in front of each one. Only the key was too coarse.

import { _resetByokSessionMemoForTests, openByokSession } from '../session';

const mockFetch = jest.fn();
jest.mock('../../platform-callback/client', () => ({
  getPlatformCallbackClient: () => ({ fetch: (...a: unknown[]) => mockFetch(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveInternalAgentId: jest.fn().mockResolvedValue(null),
}));

function reply(body: Record<string, unknown>) {
  return { ok: true, json: async () => body };
}

const BASE = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  invocationId: '00000000-0000-0000-0000-0000000000bb',
  call: { callKind: 'agent_invocation' as const },
};

beforeEach(() => {
  jest.clearAllMocks();
  _resetByokSessionMemoForTests();
});

describe('openByokSession memoisation', () => {
  it('does not reuse a GLM answer for a Grok call in the same run', async () => {
    // GLM: no customer key can pay an OpenRouter invoice.
    mockFetch.mockResolvedValueOnce(reply({ mode: 'managed', reason: 'provider_not_fundable' }));
    // Grok: the customer's xAI key pays xAI, which means leaving OpenRouter.
    mockFetch.mockResolvedValueOnce(reply({
      mode: 'byok', vendor: 'xai', baseUrl: 'https://gw/byok/xai',
      token: 't', rerouteToVendorApi: true,
    }));

    const glm = await openByokSession({
      ...BASE, resolvedProvider: 'openrouter', resolvedModelId: 'z-ai/glm-5.2',
    });
    const grok = await openByokSession({
      ...BASE, resolvedProvider: 'openrouter', resolvedModelId: 'x-ai/grok-4.6',
    });

    expect(glm).toBeNull();
    expect(grok?.vendor).toBe('xai');
    expect(grok?.rerouteToVendorApi).toBe(true);
    // Both reached the control plane: the first answer did not stand in for the
    // second.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not hand a Grok credential to a GLM call either', async () => {
    // The same collision in the other direction, which is the worse one: a
    // credential for one vendor used to fund a call to another.
    mockFetch.mockResolvedValueOnce(reply({
      mode: 'byok', vendor: 'xai', baseUrl: 'https://gw/byok/xai',
      token: 't', rerouteToVendorApi: true,
    }));
    mockFetch.mockResolvedValueOnce(reply({ mode: 'managed', reason: 'provider_not_fundable' }));

    const grok = await openByokSession({
      ...BASE, resolvedProvider: 'openrouter', resolvedModelId: 'x-ai/grok-4.6',
    });
    const glm = await openByokSession({
      ...BASE, resolvedProvider: 'openrouter', resolvedModelId: 'z-ai/glm-5.2',
    });

    expect(grok?.vendor).toBe('xai');
    expect(glm).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('still collapses repeats of the SAME call, which is what the memo is for', async () => {
    // Without this the fix would just be "delete the memo", putting a network
    // round trip in front of every step of every run.
    mockFetch.mockResolvedValue(reply({
      mode: 'byok', vendor: 'xai', baseUrl: 'https://gw/byok/xai',
      token: 't', rerouteToVendorApi: true,
    }));

    const first = await openByokSession({
      ...BASE, resolvedProvider: 'openrouter', resolvedModelId: 'x-ai/grok-4.6',
    });
    const second = await openByokSession({
      ...BASE, resolvedProvider: 'openrouter', resolvedModelId: 'x-ai/grok-4.6',
    });

    expect(first?.vendor).toBe('xai');
    expect(second?.vendor).toBe('xai');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
