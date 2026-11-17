// Grant negotiation at registration (RFC 7591 §2) — unit tests.

import { negotiateGrantTypes, usesDeviceGrant, responseTypesFor, parseGrantTypes, DEVICE_CODE_GRANT } from '../client-grants';

describe('negotiateGrantTypes', () => {
  it('gives a client that names nothing the pair every client got before the device grant', () => {
    expect(negotiateGrantTypes(undefined)).toEqual(['authorization_code', 'refresh_token']);
    expect(negotiateGrantTypes([])).toEqual(['authorization_code', 'refresh_token']);
  });

  it('narrows a request to the grants we serve, in our order, dropping the rest', () => {
    expect(negotiateGrantTypes(['implicit', DEVICE_CODE_GRANT, 'refresh_token'])).toEqual(['refresh_token', DEVICE_CODE_GRANT]);
    expect(negotiateGrantTypes(['authorization_code'])).toEqual(['authorization_code']);
  });

  it('is null when nothing requested is served, so registration can refuse rather than silently substitute', () => {
    expect(negotiateGrantTypes(['implicit', 'password'])).toBeNull();
  });
});

describe('responseTypesFor / usesDeviceGrant', () => {
  it('code goes with the authorization code grant and nothing else has a response type', () => {
    expect(responseTypesFor(['authorization_code', 'refresh_token'])).toEqual(['code']);
    expect(responseTypesFor(['refresh_token', DEVICE_CODE_GRANT])).toEqual([]);
  });

  it('reads the device grant off the negotiated list', () => {
    expect(usesDeviceGrant(['refresh_token', DEVICE_CODE_GRANT])).toBe(true);
    expect(usesDeviceGrant(['authorization_code', 'refresh_token'])).toBe(false);
  });
});

describe('parseGrantTypes', () => {
  it('reads an array, a JSON string, and treats anything else as no grants', () => {
    expect(parseGrantTypes(['authorization_code', 7, 'refresh_token'])).toEqual(['authorization_code', 'refresh_token']);
    expect(parseGrantTypes('["refresh_token"]')).toEqual(['refresh_token']);
    expect(parseGrantTypes('not json')).toEqual([]);
    expect(parseGrantTypes(null)).toEqual([]);
    expect(parseGrantTypes('{"a":1}')).toEqual([]);
  });
});
