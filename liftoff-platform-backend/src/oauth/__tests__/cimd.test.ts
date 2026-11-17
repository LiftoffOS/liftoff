import { isCimdClientId, resolveCimdClient, type CimdRedirect } from '../cimd';

// A permissive stand-in for the router's validateRegistrableUri.
const validateUri = (raw: string): CimdRedirect | null => {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      return { uri: raw, loopback_port_wildcard: false };
    }
  } catch {
    /* fall through */
  }
  return null;
};

describe('isCimdClientId', () => {
  it('accepts an https URL with a path component', () => {
    expect(isCimdClientId('https://app.example.com/client.json')).toBe(true);
  });
  it('rejects the opaque DCR client_id form', () => {
    expect(isCimdClientId('liftoff_oc_deadbeef')).toBe(false);
  });
  it('rejects http and path-less URLs', () => {
    expect(isCimdClientId('http://app.example.com/client.json')).toBe(false);
    expect(isCimdClientId('https://app.example.com')).toBe(false);
  });
});

describe('resolveCimdClient SSRF guard', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
  });

  it('blocks a private-IP host without fetching', async () => {
    const r = await resolveCimdClient('https://10.0.0.1/c.json', validateUri);
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks IPv6 loopback without fetching', async () => {
    const r = await resolveCimdClient('https://[::1]/c.json', validateUri);
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveCimdClient document validation', () => {
  const fetchMock = jest.fn();
  // A public IP literal → passes the SSRF guard with no DNS lookup.
  const CID = 'https://93.184.216.34/client.json';
  const okResp = (body: unknown, headers: Record<string, string> = {}) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  });

  beforeEach(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockReset();
  });

  it('rejects a document whose client_id does not match the URL', async () => {
    fetchMock.mockResolvedValue(okResp({ client_id: 'https://evil.example/x', client_name: 'x', redirect_uris: ['https://a/cb'] }));
    expect(await resolveCimdClient(CID, validateUri)).toBeNull();
  });

  it('rejects a document with an invalid redirect_uri', async () => {
    fetchMock.mockResolvedValue(okResp({ client_id: CID, client_name: 'x', redirect_uris: ['ftp://bad'] }));
    expect(await resolveCimdClient(CID, () => null)).toBeNull();
  });

  it('accepts a valid document and returns the validated client', async () => {
    fetchMock.mockResolvedValue(okResp({ client_id: CID, client_name: 'My App', redirect_uris: ['https://app.example/cb'] }));
    const r = await resolveCimdClient(CID, validateUri);
    expect(r).not.toBeNull();
    expect(r?.client_name).toBe('My App');
    expect(r?.redirect_uris).toEqual([{ uri: 'https://app.example/cb', loopback_port_wildcard: false }]);
    expect(r?.cachedUntil).toBeInstanceOf(Date);
  });

  it('gives a document that names no grants the pair every client got before the device grant', async () => {
    fetchMock.mockResolvedValue(okResp({ client_id: CID, client_name: 'My App', redirect_uris: ['https://app.example/cb'] }));
    expect((await resolveCimdClient(CID, validateUri))?.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });

  it('accepts a device-only document with no redirect_uris, narrowed to the grants we serve', async () => {
    fetchMock.mockResolvedValue(okResp({
      client_id: CID, client_name: 'Remote agent',
      grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'implicit'],
    }));
    const r = await resolveCimdClient(CID, validateUri);
    expect(r?.redirect_uris).toEqual([]);
    expect(r?.grant_types).toEqual(['urn:ietf:params:oauth:grant-type:device_code']);
  });

  it('still needs a redirect_uri without the device grant, and refuses a document naming only grants we do not serve', async () => {
    fetchMock.mockResolvedValue(okResp({ client_id: CID, client_name: 'x', grant_types: ['authorization_code'] }));
    expect(await resolveCimdClient(CID, validateUri)).toBeNull();
    fetchMock.mockResolvedValue(okResp({ client_id: CID, client_name: 'x', redirect_uris: ['https://app.example/cb'], grant_types: ['implicit'] }));
    expect(await resolveCimdClient(CID, validateUri)).toBeNull();
  });

  it('derives the cache horizon from Cache-Control max-age (clamped)', async () => {
    fetchMock.mockResolvedValue(
      okResp(
        { client_id: CID, client_name: 'A', redirect_uris: ['https://app.example/cb'] },
        { 'cache-control': 'max-age=3600' },
      ),
    );
    const r = await resolveCimdClient(CID, validateUri);
    const ms = (r as { cachedUntil: Date }).cachedUntil.getTime() - Date.now();
    // ~1h ahead (allowing scheduling slack), never beyond the max-age.
    expect(ms).toBeGreaterThan(3000 * 1000);
    expect(ms).toBeLessThanOrEqual(3600 * 1000 + 5000);
  });

  it('falls back to the 5-minute floor when the document is not cacheable', async () => {
    fetchMock.mockResolvedValue(
      okResp(
        { client_id: CID, client_name: 'A', redirect_uris: ['https://app.example/cb'] },
        { 'cache-control': 'no-store' },
      ),
    );
    const r = await resolveCimdClient(CID, validateUri);
    const ms = (r as { cachedUntil: Date }).cachedUntil.getTime() - Date.now();
    expect(ms).toBeGreaterThan(4 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(5 * 60 * 1000 + 5000);
  });
});
