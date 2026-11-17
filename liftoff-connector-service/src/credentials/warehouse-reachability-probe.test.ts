import { classifyProbeFailure } from './warehouse-reachability-probe.js';

describe('classifyProbeFailure (plan §4)', () => {
  it('classifies auth error codes as reconnect', () => {
    for (const code of ['permission_denied', 'unauthorized', 'authentication_failed', 'forbidden', 'invalid_credentials']) {
      expect(classifyProbeFailure(code, 'whatever')).toBe('reconnect');
    }
  });

  it('classifies auth messages (401/403/revoked/expired) as reconnect even without a code', () => {
    for (const msg of [
      'bigquery_api_error 403: caller lacks permission',
      'HTTP 401 unauthorized',
      'invalid_grant: token has been revoked',
      'the access token is expired',
      'Access denied to dataset',
    ]) {
      expect(classifyProbeFailure(undefined, msg)).toBe('reconnect');
    }
  });

  it('classifies transient failures (5xx / rate-limit / network) as transient', () => {
    for (const [code, msg] of [
      ['vendor_unavailable', 'bigquery_api_error 503: backend error'],
      ['rate_limited', 'too many requests'],
      [undefined, 'ECONNRESET socket hang up'],
      [undefined, 'timeout after 20000ms'],
    ] as Array<[string | undefined, string]>) {
      expect(classifyProbeFailure(code, msg)).toBe('transient');
    }
  });
});
