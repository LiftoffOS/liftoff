const mockGetSecret = jest.fn();
const mockGetWebToolCredential = jest.fn();
jest.mock('../../../infrastructure/secrets', () => ({
  getSecret: (...a: unknown[]) => mockGetSecret(...a),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// BYOK refactor (ADR-023): WebClawClient resolves credentials per-tenant.
jest.mock('../web-tool-secrets', () => {
  const actual = jest.requireActual('../web-tool-secrets');
  return {
    ...actual,
    getWebToolCredential: (...a: unknown[]) => mockGetWebToolCredential(...a),
  };
});

import { WebClawClient, WebClawError } from '../webclaw-client';

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecret.mockResolvedValue('api-key');
  mockGetWebToolCredential.mockResolvedValue({
    apiKey: 'api-key',
    connectorId: 'conn-webclaw',
    extra: {},
  });
});

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'Error',
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('WebClawClient.fetch', () => {
  it('returns the markdown payload on success', async () => {
    mockFetch(200, { url: 'https://x', metadata: {}, markdown: '# hi' });
    const c = new WebClawClient();
    const out = await c.fetch({ url: 'https://x' });
    expect(out.content).toBe('# hi');
    expect(out.vendor).toBe('webclaw');
    expect(out.jsRendered).toBe(false);
  });

  it('throws BYOKVendorError on 401 (invalid_key classification flips connector to errored)', async () => {
    const { BYOKVendorError } = jest.requireActual('../types');
    mockFetch(401, { error: 'bad key' });
    const c = new WebClawClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toBeInstanceOf(BYOKVendorError);
  });

  it('throws WebClawError on 422', async () => {
    mockFetch(422, { error: 'invalid' });
    const c = new WebClawClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toBeInstanceOf(WebClawError);
  });

  it('throws WebClawError when markdown is empty (antibot block)', async () => {
    mockFetch(200, { url: 'https://x', metadata: {}, markdown: '' });
    const c = new WebClawClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toThrow(/Empty markdown/);
  });

  it('refuses session_id requests (WebClaw is stateless)', async () => {
    const c = new WebClawClient();
    await expect(c.fetch({ url: 'https://x', sessionId: 's1' }))
      .rejects.toThrow(/WebClaw does not support sessions/);
  });
});
