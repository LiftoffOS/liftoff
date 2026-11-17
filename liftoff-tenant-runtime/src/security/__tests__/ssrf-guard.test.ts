// SSRF guard tests. Verifies private/loopback/link-local/metadata addresses
// are rejected and public hostnames pass.

import {
  assertNotSsrfTarget,
  isSafeFetchTarget,
  scanPayloadForUnsafeUrls,
  SsrfTargetRejected,
} from '../ssrf-guard';

describe('assertNotSsrfTarget', () => {
  it.each([
    'http://10.0.0.1/admin',
    'https://10.255.255.254/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.0.1/',
    'http://127.0.0.1/',
    'http://127.10.0.5/',
    'http://0.0.0.0/',
    'http://169.254.169.254/computeMetadata/v1/',  // GCE metadata
  ])('rejects private/loopback %s', (url) => {
    expect(() => assertNotSsrfTarget(url)).toThrow(SsrfTargetRejected);
  });

  it.each([
    'http://metadata.google.internal/',
    'http://metadata/computeMetadata/v1/',
    'http://instance-data.ec2.internal/latest/',
    'http://metadata.azure.com/',
  ])('rejects known metadata hostname %s', (url) => {
    expect(() => assertNotSsrfTarget(url)).toThrow(SsrfTargetRejected);
  });

  it('rejects non-http schemes', () => {
    expect(() => assertNotSsrfTarget('file:///etc/passwd')).toThrow(SsrfTargetRejected);
    expect(() => assertNotSsrfTarget('gopher://x/')).toThrow(SsrfTargetRejected);
  });

  it('rejects malformed URLs', () => {
    expect(() => assertNotSsrfTarget('not a url')).toThrow(SsrfTargetRejected);
  });

  it.each([
    'https://api.example.com/',
    'http://example.com:8080/path?q=1',
    'https://github.com/foo/bar',
  ])('accepts public URL %s', (url) => {
    expect(() => assertNotSsrfTarget(url)).not.toThrow();
  });

  it('rejects IPv6 loopback ::1', () => {
    expect(() => assertNotSsrfTarget('http://[::1]/')).toThrow(SsrfTargetRejected);
  });

  it('exposes a stable reason code', () => {
    try {
      assertNotSsrfTarget('http://169.254.169.254/');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfTargetRejected);
      expect((err as SsrfTargetRejected).reason).toBe('private_or_reserved_ip');
    }
  });
});

describe('isSafeFetchTarget', () => {
  it('returns true for safe', () => {
    expect(isSafeFetchTarget('https://example.com')).toBe(true);
  });

  it('returns false (does not throw) for unsafe', () => {
    expect(isSafeFetchTarget('http://10.0.0.1/')).toBe(false);
  });
});

describe('scanPayloadForUnsafeUrls', () => {
  it('returns empty when no URLs are present', () => {
    expect(scanPayloadForUnsafeUrls({ name: 'no urls here' })).toEqual([]);
  });

  it('returns empty when all URLs are public', () => {
    expect(scanPayloadForUnsafeUrls({ link: 'https://example.com/x' })).toEqual([]);
  });

  it('returns rejection for private IPs nested in objects', () => {
    const out = scanPayloadForUnsafeUrls({
      payload: { details: { callback: 'http://10.0.0.5/cb' } },
    });
    expect(out).toEqual([{ reason: 'private_or_reserved_ip', target: 'http://10.0.0.5/cb' }]);
  });

  it('returns rejection for URLs in arrays', () => {
    const out = scanPayloadForUnsafeUrls({
      urls: ['https://example.com', 'http://169.254.169.254/'],
    });
    expect(out).toHaveLength(1);
    expect(out[0].target).toBe('http://169.254.169.254/');
  });

  it('ignores strings that are not http(s) URLs', () => {
    const out = scanPayloadForUnsafeUrls({
      notAUrl: 'random string',
      mention: '@user-handle',
    });
    expect(out).toEqual([]);
  });
});
