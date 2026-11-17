// registry-branding-loader — a model onboarded via a registry row (no static
// MODEL_ID_MAP entry) must still redact to its tier codename.
const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({ getPool: () => ({ query: mockQuery }) }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { refreshRegistryModelBranding } from '../registry-branding-loader';
import { liftoffifyString, setRegistryModelBranding } from '../registry';

beforeEach(() => jest.clearAllMocks());
afterEach(() => setRegistryModelBranding(null)); // don't leak the overlay across tests

describe('registry-branding-loader', () => {
  it('installs model→codename (by tier) so a registry-only model redacts in free text', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { model_id: 'deepseek/deepseek-v4', tier: 'large' }, // → hyperion
        { model_id: 'qwen/qwen3-lite', tier: 'small' },         // → eos
      ],
    });
    const count = await refreshRegistryModelBranding();
    expect(count).toBe(2);
    // Neither id has a static STRING_REPLACEMENTS pattern — only the overlay redacts them.
    expect(liftoffifyString('routed to deepseek/deepseek-v4 today')).toBe('routed to hyperion today');
    expect(liftoffifyString('qwen/qwen3-lite overloaded')).toBe('eos overloaded');
  });

  it('skips a model whose tier has no codename — never installs a raw id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ model_id: 'x/y', tier: 'bogus-tier' }] });
    const count = await refreshRegistryModelBranding();
    expect(count).toBe(0);
    expect(liftoffifyString('x/y')).toBe('x/y'); // unchanged, but at least not mis-branded
  });
});
