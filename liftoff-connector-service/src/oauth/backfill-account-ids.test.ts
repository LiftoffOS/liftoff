// backfill-account-ids tests — verify the row-walk, identity fetch, and
// merge path. We mock the DB scope helpers, credential service, and
// identity fetchers so the test stays hermetic.

import * as pool from '../db/pool';
import * as connectorOps from './connector-ops';
import * as identityFetchers from './identity-fetchers';
import { credentialService } from '../credentials/service';
import { backfillExternalAccountIds } from './backfill-account-ids';

const ROWS = [
  // google_mail, no externalAccountId in config — should be filled
  {
    id: 'c-gmail-1',
    tenant_id: 't1',
    type: 'google_mail',
    status: 'active',
    config: {},
  },
  // slack, no externalAccountId — should be filled
  {
    id: 'c-slack-1',
    tenant_id: 't1',
    type: 'slack',
    status: 'active',
    config: null,
  },
  // attio, fetcher exists but our mock returns null → skipped_identity_unavailable
  {
    id: 'c-attio-1',
    tenant_id: 't1',
    type: 'attio',
    status: 'active',
    config: {},
  },
  // custom_mcp_server, no OAuth provider AND no API-key fetcher — skipped_no_provider
  {
    id: 'c-mcp-1',
    tenant_id: 't1',
    type: 'custom_mcp_server',
    status: 'active',
    config: {},
  },
];

describe('backfillExternalAccountIds', () => {
  let withAdminScopeSpy: jest.SpyInstance;
  let getCredsSpy: jest.SpyInstance;
  let fetchIdentitySpy: jest.SpyInstance;
  let mergeConfigSpy: jest.SpyInstance;

  beforeEach(() => {
    // Mock withAdminScope to return our fixture rows.
    withAdminScopeSpy = jest.spyOn(pool, 'withAdminScope').mockImplementation(
      (async (_ctx: unknown, fn: (c: unknown) => Promise<unknown>) => {
        const fakeClient = {
          query: async () => ({ rows: ROWS }),
        };
        return fn(fakeClient);
      }) as never,
    );

    getCredsSpy = jest.spyOn(credentialService, 'getCredentials').mockImplementation(
      async (_tenantId: string, connectorId: string) => ({
        flowKind: 'static_oauth' as const,
        accessToken: `tok-${connectorId}`,
      }),
    );

    fetchIdentitySpy = jest
      .spyOn(identityFetchers, 'fetchExternalIdentity')
      .mockImplementation(async (provider) => {
        if (provider === 'google') {
          return {
            externalAccountId: 'google-id-1',
            externalAccountLabel: 'person@example.com',
          };
        }
        if (provider === 'slack') {
          return {
            externalAccountId: 'T12345',
            externalAccountLabel: 'Acme Workspace',
          };
        }
        return null;
      });

    mergeConfigSpy = jest
      .spyOn(connectorOps, 'mergeConnectorConfig')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fills externalAccountId+Label on rows whose provider has a fetcher', async () => {
    const stats = await backfillExternalAccountIds();

    expect(stats.scanned).toBe(4);
    expect(stats.filled).toBe(2);
    // attio: fetcher exists but the mock for attio returns null
    expect(stats.skipped_identity_unavailable).toBe(1);
    // custom_mcp_server has neither OAuth provider nor API-key fetcher
    expect(stats.skipped_no_provider).toBe(1);

    // Two merges fired with the expected payloads.
    expect(mergeConfigSpy).toHaveBeenCalledTimes(2);
    expect(mergeConfigSpy).toHaveBeenCalledWith('t1', 'c-gmail-1', {
      externalAccountId: 'google-id-1',
      externalAccountLabel: 'person@example.com',
    });
    expect(mergeConfigSpy).toHaveBeenCalledWith('t1', 'c-slack-1', {
      externalAccountId: 'T12345',
      externalAccountLabel: 'Acme Workspace',
    });
  });

  it('does not call getCredentials when no OAuth provider exists for the type', async () => {
    await backfillExternalAccountIds();
    // custom_mcp_server has no OAuth provider — getCredentials is never touched.
    // google_mail, slack, attio all hit the OAuth branch.
    expect(getCredsSpy).toHaveBeenCalledTimes(3);
    expect(getCredsSpy).toHaveBeenCalledWith('t1', 'c-gmail-1');
    expect(getCredsSpy).toHaveBeenCalledWith('t1', 'c-slack-1');
    expect(getCredsSpy).toHaveBeenCalledWith('t1', 'c-attio-1');
  });

  it('skips rows whose credentials cannot be loaded (e.g. revoked/expired)', async () => {
    getCredsSpy.mockImplementation(async (_t: string, id: string) => {
      if (id === 'c-gmail-1') {
        throw new Error('No credentials found');
      }
      return {
        flowKind: 'static_oauth' as const,
        accessToken: `tok-${id}`,
      };
    });

    const stats = await backfillExternalAccountIds();
    expect(stats.skipped_no_credentials).toBe(1);
    expect(stats.filled).toBe(1); // only slack — attio fetcher mock returns null
  });

  it('skips rows whose identity fetcher returns null (whoami non-2xx)', async () => {
    fetchIdentitySpy.mockResolvedValue(null);
    const stats = await backfillExternalAccountIds();
    // gmail + slack + attio all hit the OAuth branch and the mock returns null.
    expect(stats.skipped_identity_unavailable).toBe(3);
    expect(stats.filled).toBe(0);
    expect(mergeConfigSpy).not.toHaveBeenCalled();
  });

  it('logs and counts mergeConnectorConfig failures without crashing the run', async () => {
    mergeConfigSpy.mockRejectedValue(new Error('db down'));
    const stats = await backfillExternalAccountIds();
    expect(stats.errored).toBe(2);
    expect(stats.filled).toBe(0);
    // Backfill continued past the first error to attempt the second row.
    expect(mergeConfigSpy).toHaveBeenCalledTimes(2);
  });

  it('returns zero-work stats when no rows need backfill', async () => {
    withAdminScopeSpy.mockImplementation(
      (async (_ctx: unknown, fn: (c: unknown) => Promise<unknown>) => {
        const fakeClient = { query: async () => ({ rows: [] }) };
        return fn(fakeClient);
      }) as never,
    );
    const stats = await backfillExternalAccountIds();
    expect(stats.scanned).toBe(0);
    expect(stats.filled).toBe(0);
    expect(mergeConfigSpy).not.toHaveBeenCalled();
  });

  it('does not throw when listConnectorsNeedingBackfill itself fails', async () => {
    withAdminScopeSpy.mockRejectedValue(new Error('admin pool unavailable'));
    const stats = await backfillExternalAccountIds();
    expect(stats.scanned).toBe(0);
    expect(stats.filled).toBe(0);
  });
});
