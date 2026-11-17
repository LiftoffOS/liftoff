// Plan v13 Change 3 counterpart: PB pins the OIDC audience to the EXACT
// canonical endpoint URL, so this asserts what ServiceClient actually mints —
// getIdTokenClient must receive the FULL endpoint URL (base + path), never
// the bare origin. If this contract drifts, PB's strict verifier would 403
// every legitimate recall call.

const mockGetIdTokenClient = jest.fn().mockResolvedValue({
  getRequestHeaders: async () => ({ Authorization: 'Bearer minted-oidc-token' }),
});

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn(() => ({ getIdTokenClient: mockGetIdTokenClient })),
  OAuth2Client: jest.fn(),
}));

describe('ServiceClient OIDC audience (plan v13)', () => {
  const BASE = 'https://api-test.example.com';
  const PATH = '/api/internal/platform-tools/agent-conversations';

  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.PLATFORM_BACKEND_URL = BASE;
    process.env.PLATFORM_CALLBACK_TOKEN = 'test-service-token';
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
    } as unknown as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env.PLATFORM_BACKEND_URL;
    delete process.env.PLATFORM_CALLBACK_TOKEN;
  });

  it('mints the token for the FULL endpoint URL, not the origin', async () => {
    // Fresh module so getPlatformCallbackClient() builds with this test's env.
    const { getPlatformCallbackClient } = require('../client') as typeof import('../client');
    const client = getPlatformCallbackClient();
    expect(client).not.toBeNull();

    await client!.fetch('platform', PATH, {
      method: 'POST',
      body: JSON.stringify({ probe: true }),
    });

    expect(mockGetIdTokenClient).toHaveBeenCalledWith(`${BASE}${PATH}`);
    expect(mockGetIdTokenClient).not.toHaveBeenCalledWith(BASE);
  });
});
