// registry-tier-loader — every provider's tier→slug map is driven by the models
// registry (latest approved model per tier), overlaid onto the provider's static seed.
const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({ getPool: () => ({ query: mockQuery }) }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { refreshRegistryTierModels } from '../registry-tier-loader';

beforeEach(() => jest.clearAllMocks());

describe('registry-tier-loader', () => {
  it('applies the registry model per tier to the provider', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { tier: 'large', model_id: 'z-ai/glm-6' },
        { tier: 'small', model_id: 'z-ai/glm-4.7-flash' },
      ],
    });
    const applied: Array<Partial<Record<string, string>>> = [];
    const provider = { applyRegistryTierModels: (o: Partial<Record<string, string>>) => applied.push(o) };
    const count = await refreshRegistryTierModels([provider], ['openrouter']);
    expect(count).toBe(2);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({ large: 'z-ai/glm-6', small: 'z-ai/glm-4.7-flash' });
  });

  it('applies an empty overlay when the registry has no rows (provider keeps its seed)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const applied: Array<unknown> = [];
    const provider = { applyRegistryTierModels: (o: unknown) => applied.push(o) };
    const count = await refreshRegistryTierModels([provider], ['openrouter']);
    expect(count).toBe(0);
    expect(applied[0]).toEqual({});
  });

  it('gives every sink the same overlay — the OpenAI pool is four instances', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { tier: 'large', model_id: 'gpt-5.5' },
        { tier: 'medium', model_id: 'gpt-5.4-mini' },
        { tier: 'small', model_id: 'gpt-5.4-nano' },
      ],
    });
    const applied: Array<Partial<Record<string, string>>> = [];
    const sinks = [0, 1, 2, 3].map(() => ({
      applyRegistryTierModels: (o: Partial<Record<string, string>>) => applied.push(o),
    }));
    const count = await refreshRegistryTierModels(sinks, ['openai']);
    expect(count).toBe(3);
    expect(applied).toHaveLength(4);
    for (const o of applied) {
      expect(o).toEqual({ large: 'gpt-5.5', medium: 'gpt-5.4-mini', small: 'gpt-5.4-nano' });
    }
  });

  it('queries only the registry provider keys it was given', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await refreshRegistryTierModels([{ applyRegistryTierModels: () => {} }], ['anthropic']);
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [['anthropic']]);
  });
});

// The context windows ride the same registry, into the cache the chat loops
// read through `llmClient.contextWindowFor`.
import {
  _setRegistryContextWindowsForTests,
  contextWindowFromRegistry,
  refreshRegistryContextWindows,
} from '../registry-tier-loader';

describe('registry context windows', () => {
  beforeEach(() => _setRegistryContextWindowsForTests({}));

  it('caches every approved model\'s window under its execution provider', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { provider: 'anthropic', model_id: 'claude-x', context_window: '1000000' },
        { provider: 'openai', model_id: 'gpt-x', context_window: 400000 },
      ],
    });
    const count = await refreshRegistryContextWindows(['anthropic', 'openai']);
    expect(count).toBe(2);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('context_window'), [['anthropic', 'openai']]);
    expect(contextWindowFromRegistry('anthropic', 'claude-x')).toBe(1_000_000);
    expect(contextWindowFromRegistry('openai', 'gpt-x')).toBe(400_000);
    expect(contextWindowFromRegistry('anthropic', 'unknown')).toBeUndefined();
  });

  it('a foreign provider key falls back to the model id', () => {
    // This used to also assert that the Vertex provider read the Anthropic
    // rows under the 'anthropic' key. Claude over Google Vertex is retired and
    // that branch went with it — this is a REQUEST-time lookup, not an
    // accounting one, so nothing asks it about a historic row.
    _setRegistryContextWindowsForTests({ 'anthropic:claude-x': 200_000, 'glm:z-ai/glm-6': 128_000 });
    expect(contextWindowFromRegistry('openrouter', 'z-ai/glm-6')).toBe(128_000);
  });
});
