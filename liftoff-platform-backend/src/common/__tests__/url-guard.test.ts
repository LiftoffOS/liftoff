// E1 — SSRF guard.
//
// The cases that matter are the ones an attacker actually reaches for: the
// cloud metadata address (which hands out service-account tokens), the same
// thing by hostname, private ranges, and the IPv6 spellings of both.

import { assertPublicUrl, BlockedUrlError, ipv4Blocked, isBlockedIp, isPublicUrl } from '../url-guard';

jest.mock('dns/promises', () => ({
  __esModule: true,
  default: { lookup: jest.fn() },
}));

import dns from 'dns/promises';

const mockLookup = dns.lookup as unknown as jest.Mock;

beforeEach(() => {
  mockLookup.mockReset();
  // Public by default, so a test that cares about the hostname rather than the
  // address does not have to stub one.
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('ipv4Blocked', () => {
  it.each([
    ['169.254.169.254', 'cloud metadata'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private class A'],
    ['172.16.0.1', 'private class B'],
    ['172.31.255.255', 'private class B upper bound'],
    ['192.168.1.1', 'private class C'],
    ['100.64.0.1', 'CGNAT'],
    ['0.0.0.0', 'this-network'],
    ['224.0.0.1', 'multicast'],
    ['999.1.1.1', 'malformed fails closed'],
  ])('blocks %s (%s)', (ip) => {
    expect(ipv4Blocked(ip)).toBe(true);
  });

  it.each([['93.184.216.34'], ['8.8.8.8'], ['172.15.0.1'], ['172.32.0.1']])(
    'allows the public address %s',
    (ip) => {
      expect(ipv4Blocked(ip)).toBe(false);
    },
  );
});

describe('isBlockedIp', () => {
  it.each([
    ['::1', 'IPv6 loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['not-an-ip', 'non-address fails closed'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it('allows a public IPv6 address', () => {
    expect(isBlockedIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('blocks the metadata IP even when the URL looks ordinary', async () => {
    mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertPublicUrl('https://totally-normal.example.com/x')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('blocks the metadata hostname without consulting DNS', async () => {
    await expect(assertPublicUrl('http://metadata.google.internal/computeMetadata/v1/', { allowHttp: true }))
      .rejects.toMatchObject({ reason: 'hostname' });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('blocks a host that resolves to a private address (DNS rebinding attempt)', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertPublicUrl('https://evil.example.com')).rejects.toMatchObject({ reason: 'address' });
  });

  it('blocks when ANY resolved address is private, not just the first', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(assertPublicUrl('https://mixed.example.com')).rejects.toMatchObject({ reason: 'address' });
  });

  it('blocks non-http schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toMatchObject({ reason: 'scheme' });
    await expect(assertPublicUrl('gopher://example.com')).rejects.toMatchObject({ reason: 'scheme' });
  });

  it('blocks plain http unless the caller opts in', async () => {
    await expect(assertPublicUrl('http://example.com')).rejects.toMatchObject({ reason: 'scheme' });
    await expect(assertPublicUrl('http://example.com', { allowHttp: true })).resolves.toBeInstanceOf(URL);
  });

  it('blocks an unresolvable host rather than assuming it is safe', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertPublicUrl('https://nope.example.com')).rejects.toMatchObject({ reason: 'unresolvable' });
  });

  it('blocks a literal private IP in the URL', async () => {
    await expect(assertPublicUrl('https://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('blocks a bracketed IPv6 loopback literal', async () => {
    await expect(assertPublicUrl('https://[::1]:8080/mcp')).rejects.toMatchObject({ reason: 'address' });
  });

  it('allows an ordinary public https endpoint', async () => {
    await expect(assertPublicUrl('https://mcp.example.com/sse')).resolves.toBeInstanceOf(URL);
  });
});

describe('isPublicUrl', () => {
  it('reports false instead of throwing, for filtering', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(isPublicUrl('https://internal.example.com')).resolves.toBe(false);
  });

  it('reports true for a public endpoint', async () => {
    await expect(isPublicUrl('https://mcp.example.com')).resolves.toBe(true);
  });
});
