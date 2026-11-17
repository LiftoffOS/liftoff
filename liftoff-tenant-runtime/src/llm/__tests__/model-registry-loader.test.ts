// model-registry-loader — one platform-backend snapshot installs ALL THREE
// overlays (pricing, branding, context window), so a model onboarded via a
// registry row only — with no static entry in any table — is priced, redacted
// AND sized in the tenant-runtime.
const mockFetch = jest.fn();
jest.mock('../../clients/platform-backend-client', () => ({ fetchModelRegistry: () => mockFetch() }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { refreshModelRegistry } from '../model-registry-loader';
import { getModelPricing, setModelPricingRates } from '../pricing';
import { liftoffifyString, setRegistryModelBranding } from '../../branding/registry';
import { contextWindowForModel, setModelContextWindows } from '../context-window';

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  setModelPricingRates(null);
  setRegistryModelBranding(null);
  setModelContextWindows(null);
});

describe('model-registry-loader (TR)', () => {
  it('prices AND redacts a registry-only model from a single snapshot', async () => {
    mockFetch.mockResolvedValueOnce({
      pricing: [
        {
          provider: 'deepseek',
          model_id: 'deepseek/deepseek-v4',
          input_per_m: '0.5',
          output_per_m: '1.5',
          cache_read_per_m: '0.05',
        },
      ],
      branding: [{ model_id: 'deepseek/deepseek-v4', codename: 'hyperion' }],
      windows: [{ provider: 'deepseek', model_id: 'deepseek/deepseek-v4', context_window: 164000 }],
    });

    const counts = await refreshModelRegistry();
    expect(counts).toEqual({ pricing: 1, branding: 1, windows: 1, tiers: 0, surfaces: 0 });

    // Priced from the synced overlay (not in the static MODEL_PRICING table).
    const pricing = getModelPricing('deepseek/deepseek-v4', 'deepseek');
    expect(pricing?.inputPricePerMillion).toBe(0.5);
    expect(pricing?.outputPricePerMillion).toBe(1.5);
    expect(pricing?.cachedInputPricePerMillion).toBe(0.05);

    // Redacted from the branding overlay — the raw vendor id never surfaces.
    expect(liftoffifyString('routed to deepseek/deepseek-v4')).toBe('routed to hyperion');

    // Sized from the window overlay, and labelled `registry` — which is what
    // allows a consumer to act destructively on it. A provider floor could not.
    const window = contextWindowForModel('deepseek', 'deepseek/deepseek-v4');
    expect(window).toEqual({ tokens: 164000, source: 'registry' });
  });

  // A platform-backend that predates the context_window column sends no
  // `windows` key at all. The loader must install an empty overlay rather than
  // throw, so pricing and branding still land during a staggered deploy.
  it('tolerates a snapshot with no windows key', async () => {
    mockFetch.mockResolvedValueOnce({
      pricing: [],
      branding: [{ model_id: 'deepseek/deepseek-v4', codename: 'hyperion' }],
    });
    const counts = await refreshModelRegistry();
    expect(counts).toEqual({ pricing: 0, branding: 1, windows: 0, tiers: 0, surfaces: 0 });
    expect(contextWindowForModel('deepseek', 'deepseek/deepseek-v4').source).toBe('provider_floor');
  });

  it('clearing the overlays restores static-only behaviour', async () => {
    mockFetch.mockResolvedValueOnce({
      pricing: [
        { provider: 'deepseek', model_id: 'deepseek/deepseek-v4', input_per_m: '9', output_per_m: '9', cache_read_per_m: null },
      ],
      branding: [{ model_id: 'deepseek/deepseek-v4', codename: 'hyperion' }],
      windows: [{ provider: 'deepseek', model_id: 'deepseek/deepseek-v4', context_window: 164000 }],
    });
    await refreshModelRegistry();
    setModelPricingRates(null);
    setRegistryModelBranding(null);
    setModelContextWindows(null);
    expect(getModelPricing('deepseek/deepseek-v4', 'deepseek')).toBeNull();
    expect(liftoffifyString('deepseek/deepseek-v4')).toBe('deepseek/deepseek-v4');
    expect(contextWindowForModel('deepseek', 'deepseek/deepseek-v4').source).toBe('provider_floor');
  });
});
