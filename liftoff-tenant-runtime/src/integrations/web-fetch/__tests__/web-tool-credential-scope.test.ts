/**
 * getWebToolCredential under an explicit credential scope.
 *
 * A workspace with two Exa accounts, one of them bound to the team, serves
 * the team from that one; a scope that names ids none of which is usable is
 * "no connector", so the chain moves on rather than borrowing another
 * account; NO_WORKSPACE_CONNECTOR is "no connector" outright; ANY_CONNECTOR
 * is today's pool, in creation order. scopeFor() derives each of them from a
 * run's vendor scope.
 */

const mockListTenantConnectors = jest.fn();
const mockGetCredentials = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../../../infrastructure/logging', () => ({ logger: mockLogger }));
jest.mock('../../../infrastructure/secrets', () => ({ getSecret: jest.fn() }));
jest.mock('../../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({
    listTenantConnectors: (...a: unknown[]) => mockListTenantConnectors(...a),
    getCredentials: (...a: unknown[]) => mockGetCredentials(...a),
  }),
}));

import { _resetCredentialPoolForTesting, markCredentialCooling } from '../credential-pool';
import { ANY_CONNECTOR, NO_WORKSPACE_CONNECTOR, scopeFor } from '../credential-scope';
import {
  getWebToolCredential, getTenantConnectedWebVendors, invalidateWebToolCredentialCache, onWebToolCredentialInvalidated,
  STRICT_WEB_TOOL_VENDORS, WEB_ROUTABLE_VENDORS, VendorNotConnected,
} from '../web-tool-secrets';

const TENANT = 't-1';

beforeEach(() => {
  jest.clearAllMocks();
  _resetCredentialPoolForTesting();
  invalidateWebToolCredentialCache(TENANT, 'exa');
  mockListTenantConnectors.mockResolvedValue({
    connectors: [
      { id: 'c-exa-1', connectorType: 'exa' },
      { id: 'c-exa-2', connectorType: 'exa' },
    ],
  });
  mockGetCredentials.mockImplementation(async ({ connectorId }: { connectorId: string }) => ({
    apiKey: { apiKey: `key-${connectorId}`, extra: {} },
  }));
});

const scoped = (ids: string[]) => getWebToolCredential(TENANT, 'exa', { connectorIds: new Set(ids) });

describe('getWebToolCredential under a scope', () => {
  it('serves the bound connector, not the first one the workspace connected', async () => {
    const cred = await scoped(['c-exa-2']);
    expect(cred.connectorId).toBe('c-exa-2');
    expect(cred.apiKey).toBe('key-c-exa-2');
  });

  it('ANY_CONNECTOR is today\'s pool: the first connector in creation order', async () => {
    const cred = await getWebToolCredential(TENANT, 'exa', ANY_CONNECTOR);
    expect(cred.connectorId).toBe('c-exa-1');
  });

  it('a scope naming no usable connector is "not connected", never another account', async () => {
    await expect(scoped(['c-exa-gone'])).rejects.toBeInstanceOf(VendorNotConnected);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ vendor: 'exa', pooled: 2, allowed: ['c-exa-gone'] }),
      expect.any(String),
    );
  });

  it('NO_WORKSPACE_CONNECTOR is "not connected" even though the workspace has two', async () => {
    await expect(getWebToolCredential(TENANT, 'exa', NO_WORKSPACE_CONNECTOR)).rejects.toBeInstanceOf(VendorNotConnected);
    expect(mockGetCredentials).toHaveBeenCalled(); // the pool was read; none of it was allowed
  });

  it('the pool\'s cooldowns still apply inside a scope', async () => {
    markCredentialCooling({ tenantId: TENANT, vendor: 'exa', connectorId: 'c-exa-2', reason: 'rate_limited' });
    await expect(scoped(['c-exa-2'])).rejects.toThrow(/byok_rate_limited/);
  });
});

describe('scopeFor', () => {
  const base = { excluded: [], basis: 'bound' as const };

  it('a bound vendor with ids → those ids', () => {
    const scope = scopeFor(
      { ...base, vendors: new Set(['exa']), connectorIds: new Map([['exa', new Set(['c-exa-2'])]]) },
      'exa',
    );
    expect([...(scope.connectorIds ?? [])]).toEqual(['c-exa-2']);
  });

  it('a bound vendor named by type alone (the legacy shape) → any connector', () => {
    const scope = scopeFor(
      { ...base, vendors: new Set(['exa']), connectorIds: new Map([['exa', new Set()]]) },
      'exa',
    );
    expect(scope).toBe(ANY_CONNECTOR);
  });

  it('a vendor the run may not use → no workspace connector at all', () => {
    const scope = scopeFor(
      { ...base, vendors: new Set(['exa']), connectorIds: new Map([['exa', new Set(['c-exa-2'])]]) },
      'steel',
    );
    expect(scope).toBe(NO_WORKSPACE_CONNECTOR);
    expect(scope.connectorIds?.size).toBe(0);
  });
});

describe('the login source among the strict vendors', () => {
  it('is a strict vendor (the pool, the cache and the BYOK path serve it) but not a routable one (no web call, no palette, no binding exclusion)', () => {
    expect(STRICT_WEB_TOOL_VENDORS).toContain('onepassword');
    expect(WEB_ROUTABLE_VENDORS).not.toContain('onepassword');
    expect(WEB_ROUTABLE_VENDORS).toEqual(STRICT_WEB_TOOL_VENDORS.filter((v) => v !== 'onepassword'));
  });

  it('the connected set is asked for the routable vendors only', async () => {
    mockListTenantConnectors.mockResolvedValueOnce({ connectors: [{ id: 'c-steel', connectorType: 'steel' }] });
    const connected = await getTenantConnectedWebVendors(TENANT);
    expect(connected).toEqual(new Set(['steel']));
    const asked = mockListTenantConnectors.mock.calls[0][0] as { connectorTypes: string[] };
    expect(asked.connectorTypes).not.toContain('onepassword');
    expect(asked.connectorTypes).toEqual([...WEB_ROUTABLE_VENDORS]);
  });

  it('serves the 1Password token through the same pool as every other vendor', async () => {
    mockListTenantConnectors.mockResolvedValueOnce({ connectors: [{ id: 'c-1p', connectorType: 'onepassword' }] });
    const cred = await getWebToolCredential(TENANT, 'onepassword', ANY_CONNECTOR);
    expect(cred).toEqual({ apiKey: 'key-c-1p', connectorId: 'c-1p', extra: {} });
    const asked = mockListTenantConnectors.mock.calls[0][0] as { connectorTypes: string[]; statuses: string[] };
    expect(asked.connectorTypes).toEqual(['onepassword']);
    expect(asked.statuses).toEqual(['active', 'connected']);
  });

  it('an invalidation reaches the listeners with the tenant and vendor, and a listener that throws harms no other', () => {
    const seen: Array<[string, string]> = [];
    const off1 = onWebToolCredentialInvalidated(() => { throw new Error('mine'); });
    const off2 = onWebToolCredentialInvalidated((tenantId, vendor) => { seen.push([tenantId, vendor]); });
    expect(() => invalidateWebToolCredentialCache(TENANT, 'onepassword')).not.toThrow();
    expect(seen).toEqual([[TENANT, 'onepassword']]);
    off1();
    off2();
    invalidateWebToolCredentialCache(TENANT, 'onepassword');
    expect(seen).toHaveLength(1);
  });
});
