import { isReconnectRequired } from './token-keepalive.js';
import { OAuthRefreshError } from './service.js';

describe('credential keepalive — dead vs transient classification', () => {
  it('flags only reconnect_required as genuinely dead (→ needs_reconnect)', () => {
    expect(isReconnectRequired(new OAuthRefreshError('reconnect_required', 'refresh token revoked', { connectorId: 'c', tenantId: 't' }))).toBe(true);
  });

  it('does NOT flag transient / unknown / non-OAuth errors (→ retry next cycle)', () => {
    expect(isReconnectRequired(new OAuthRefreshError('unknown', 'ECONNRESET', { connectorId: 'c', tenantId: 't' }))).toBe(false);
    expect(isReconnectRequired(new Error('socket hang up'))).toBe(false);
    expect(isReconnectRequired('some string')).toBe(false);
    expect(isReconnectRequired(undefined)).toBe(false);
  });
});
