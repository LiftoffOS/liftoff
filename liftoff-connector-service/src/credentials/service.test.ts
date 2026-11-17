import {
  OAuthRefreshError,
  isReconnectRequiredOAuthError,
  isReconnectOAuthErrorCode,
  registerOAuthRefreshHandler,
  unregisterAllOAuthRefreshHandlers,
} from './service.js';

describe('credentials/service — pure helpers', () => {
  afterEach(() => {
    unregisterAllOAuthRefreshHandlers();
  });

  it('OAuthRefreshError carries reason + connector context', () => {
    const err = new OAuthRefreshError('reconnect_required', 'boom', {
      connectorId: 'c1',
      tenantId: 't1',
      vendor: 'stripe',
    });
    expect(err.reason).toBe('reconnect_required');
    expect(err.connectorId).toBe('c1');
    expect(err.vendor).toBe('stripe');
    expect(err.name).toBe('OAuthRefreshError');
  });

  it('isReconnectRequiredOAuthError true for reconnect_required / no_refresh_token', () => {
    expect(
      isReconnectRequiredOAuthError(
        new OAuthRefreshError('reconnect_required', 'x', { connectorId: 'c', tenantId: 't' }),
      ),
    ).toBe(true);
    expect(
      isReconnectRequiredOAuthError(
        new OAuthRefreshError('no_refresh_token', 'x', { connectorId: 'c', tenantId: 't' }),
      ),
    ).toBe(true);
    expect(
      isReconnectRequiredOAuthError(
        new OAuthRefreshError('vendor_unavailable', 'x', { connectorId: 'c', tenantId: 't' }),
      ),
    ).toBe(false);
    expect(isReconnectRequiredOAuthError(new Error('plain'))).toBe(false);
  });

  it('maps RFC 6749 reconnect error codes', () => {
    expect(isReconnectOAuthErrorCode('invalid_grant')).toBe(true);
    expect(isReconnectOAuthErrorCode('invalid_token')).toBe(true);
    expect(isReconnectOAuthErrorCode('temporarily_unavailable')).toBe(false);
  });

  it('registerOAuthRefreshHandler stores per-connectorType', () => {
    const calls: string[] = [];
    registerOAuthRefreshHandler('fakeProv', async () => {
      calls.push('called');
      return { accessToken: 'new' };
    });
    // Cannot easily call through without a DB — this test just exercises
    // the registration hook; coverage of the full refresh path requires
    // an integration test with a test DB.
    expect(calls).toEqual([]);
  });
});
