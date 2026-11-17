// One rule for which credential a vendor runs on, shared by search and
// execution: the first positively connected workspace connector of the type,
// else the platform key. Apify is always the platform key. A failed lookup
// degrades to the platform key and says so.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/connector-service-client', () => ({ listConnectorsForTenant: jest.fn() }));

import { listConnectorsForTenant } from '../../connectors/connector-service-client';
import { log } from '../../infrastructure/logging';
import { credentialCooling, credentialRefFor, platformOnlyCredentials, resolveCredentialMap, selectConnectedConnector } from '../credential-scope';

beforeEach(() => jest.clearAllMocks());

describe('selectConnectedConnector', () => {
  const rows = [
    { id: 'c-placeholder', type: 'zoho', status: 'reconnect_required' },
    { id: 'c-1', type: 'zoho', status: 'active' },
    { id: 'c-2', type: 'zoho', status: 'connected' },
    { id: 'c-3', type: 'tikhub', status: 'active' },
  ];
  it('is the first positively connected row of the type', () => {
    expect(selectConnectedConnector(rows, 'zoho')?.id).toBe('c-1');
    expect(selectConnectedConnector(rows, 'tikhub')?.id).toBe('c-3');
    expect(selectConnectedConnector(rows, 'strale')).toBeNull();
  });
});

describe('credentialRefFor', () => {
  it('names the connector when there is one, the platform key otherwise', () => {
    expect(credentialRefFor('zoho', 'c-1')).toBe('connector:c-1');
    expect(credentialRefFor('zoho', null)).toBe('internal:zoho');
    expect(credentialRefFor('apify', 'c-apify')).toBe('connector:c-apify');
    expect(credentialRefFor('apify', null)).toBe('internal:apify');
  });
});

describe('credentialCooling', () => {
  const cooling = (parked: string[]) => (ref: string) => parked.includes(ref);

  it('a vendor with only the connected key is unusable when that key is parked', () => {
    const resolved = { connectorId: 'c-1', credentialRef: 'connector:c-1' };
    expect(credentialCooling('zoho', resolved, cooling(['connector:c-1']))).toBe(true);
    expect(credentialCooling('zoho', resolved, cooling([]))).toBe(false);
  });

  it('apify with a connected key stays usable while the platform rungs are not parked, and is unusable only when both are', () => {
    const resolved = { connectorId: 'c-apify', credentialRef: 'connector:c-apify' };
    expect(credentialCooling('apify', resolved, cooling(['connector:c-apify']))).toBe(false);
    expect(credentialCooling('apify', resolved, cooling(['connector:c-apify', 'internal:apify']))).toBe(true);
    expect(credentialCooling('apify', { connectorId: null, credentialRef: 'internal:apify' }, cooling(['internal:apify']))).toBe(true);
  });
});

describe('resolveCredentialMap', () => {
  it('resolves every type from one listing, per the shared rule', async () => {
    (listConnectorsForTenant as jest.Mock).mockResolvedValue([
      { id: 'c-1', type: 'zoho', status: 'active' },
      { id: 'c-2', type: 'zoho', status: 'active' },
      { id: 'c-apify', type: 'apify', status: 'active' },
    ]);
    const credentials = await resolveCredentialMap('t1', 'acct-1');
    expect(listConnectorsForTenant).toHaveBeenCalledTimes(1);
    expect(listConnectorsForTenant).toHaveBeenCalledWith('t1', 'acct-1');
    expect(credentials('zoho')).toEqual({ connectorId: 'c-1', credentialRef: 'connector:c-1' });
    expect(credentials('tikhub')).toEqual({ connectorId: null, credentialRef: 'internal:tikhub' });
    // A workspace's own Apify binding does not change the key an actor runs on.
    expect(credentials('apify')).toEqual({ connectorId: 'c-apify', credentialRef: 'connector:c-apify' });
  });

  it('with no account, every vendor is the platform key and no lookup is made', async () => {
    const credentials = await resolveCredentialMap('t1', undefined);
    expect(listConnectorsForTenant).not.toHaveBeenCalled();
    expect(credentials).toBe(platformOnlyCredentials);
    expect(credentials('zoho')).toEqual({ connectorId: null, credentialRef: 'internal:zoho' });
  });

  it('a failed lookup keeps the platform fallback and logs that search may be degraded', async () => {
    (listConnectorsForTenant as jest.Mock).mockRejectedValue(new Error('503'));
    const credentials = await resolveCredentialMap('t1', 'acct-1');
    expect(credentials('zoho')).toEqual({ connectorId: null, credentialRef: 'internal:zoho' });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }), expect.stringContaining('search may be degraded'));
  });
});
