// Tests for the composio_managed branch added to ConnectorCredentialService.
//
// The legacy branch (connector_credentials row + Secret Manager) is covered
// by integration tests. These unit tests focus on the new branch and prove
// that callers see ONE uniform `getCredentials` / `revokeCredentials` /
// `storeCredentials` surface — Composio dispatch is invisible to them.

// Mock the SDK-bound helpers but keep the real ComposioAccountNotActiveError
// class so `instanceof` checks + error.message stay accurate in the service.
jest.mock('../oauth/composio-client.js', () => {
  const actual = jest.requireActual('../oauth/composio-client.js');
  return {
    ...actual,
    assertComposioAccountActive: jest.fn(),
    composioProxyRequest: jest.fn(),
    deleteComposioConnectedAccount: jest.fn(),
  };
});
jest.mock('../secrets/client.js');
jest.mock('../db/pool.js');

import { ConnectorCredentialService, OAuthRefreshError } from './service.js';
import {
  ComposioAccountNotActiveError,
  assertComposioAccountActive,
  deleteComposioConnectedAccount,
} from '../oauth/composio-client.js';
import { getConnectorCredential } from '../secrets/client.js';
import { withTenantScope } from '../db/pool.js';

const mockAssertComposioAccountActive = assertComposioAccountActive as jest.MockedFunction<typeof assertComposioAccountActive>;
const mockDeleteComposioConnectedAccount = deleteComposioConnectedAccount as jest.MockedFunction<typeof deleteComposioConnectedAccount>;
const mockGetConnectorCredential = getConnectorCredential as jest.MockedFunction<typeof getConnectorCredential>;
const mockWithTenantScope = withTenantScope as jest.MockedFunction<typeof withTenantScope>;

const COMPOSIO_TENANT = 'tenant-1';
const COMPOSIO_CONNECTOR = 'gmail-conn-1';
const COMPOSIO_ACCOUNT = 'ca_TEST123';

function stubGetConnectorConfig(
  service: ConnectorCredentialService,
  result: { connectorType: string; config: Record<string, unknown> } | null,
): jest.SpyInstance {
  return jest
    .spyOn(service, 'getConnectorConfig')
    .mockResolvedValue(result);
}

function stubGetCredentialRecord(
  service: ConnectorCredentialService,
  result: Awaited<ReturnType<ConnectorCredentialService['getCredentialRecord']>>,
): jest.SpyInstance {
  return jest
    .spyOn(service, 'getCredentialRecord')
    .mockResolvedValue(result);
}

describe('ConnectorCredentialService — composio_managed branch', () => {
  let service: ConnectorCredentialService;

  beforeEach(() => {
    service = new ConnectorCredentialService();
    jest.clearAllMocks();
    // Default: withTenantScope just invokes its callback with a fake client
    // so the legacy SQL paths in the service don't blow up when reached.
    mockWithTenantScope.mockImplementation(async (_tenantId, cb) => {
      return cb({ query: jest.fn().mockResolvedValue({ rows: [] }) } as never);
    });
  });

  describe('getCredentials', () => {
    it('returns composio-routed credentials for a composio_managed connector', async () => {
      stubGetConnectorConfig(service, {
        connectorType: 'google_mail',
        config: { composioConnectedAccountId: COMPOSIO_ACCOUNT },
      });
      mockAssertComposioAccountActive.mockResolvedValue(undefined);

      const creds = await service.getCredentials(COMPOSIO_TENANT, COMPOSIO_CONNECTOR);

      expect(creds.flowKind).toBe('composio_managed');
      // Composio never exposes the access token — vendor clients route
      // through proxyExecute using composioConnectedAccountId instead.
      expect(creds.accessToken).toBe('');
      expect(creds.connectorConfig).toEqual({ composioConnectedAccountId: COMPOSIO_ACCOUNT });
      expect(mockAssertComposioAccountActive).toHaveBeenCalledWith(COMPOSIO_ACCOUNT);
      // Legacy DB/SM lookups must NOT fire for composio_managed connectors.
      expect(mockGetConnectorCredential).not.toHaveBeenCalled();
    });

    it('ComposioAccountNotActiveError → throws OAuthRefreshError(reconnect_required) with id in message', async () => {
      stubGetConnectorConfig(service, {
        connectorType: 'google_mail',
        config: { composioConnectedAccountId: COMPOSIO_ACCOUNT },
      });
      mockAssertComposioAccountActive.mockRejectedValue(
        new ComposioAccountNotActiveError(COMPOSIO_ACCOUNT, 'EXPIRED', 'token revoked at vendor'),
      );

      const err = await service
        .getCredentials(COMPOSIO_TENANT, COMPOSIO_CONNECTOR)
        .catch((e) => e);

      expect(err).toBeInstanceOf(OAuthRefreshError);
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
      expect(err.message).toContain(COMPOSIO_ACCOUNT);
      expect(err.message).toContain('EXPIRED');
    });

    it('missing composioConnectedAccountId → OAuthRefreshError(reconnect_required) with clear message', async () => {
      stubGetConnectorConfig(service, {
        connectorType: 'google_mail',
        config: {}, // no composioConnectedAccountId
      });

      const err = await service
        .getCredentials(COMPOSIO_TENANT, COMPOSIO_CONNECTOR)
        .catch((e) => e);

      expect(err).toBeInstanceOf(OAuthRefreshError);
      expect((err as OAuthRefreshError).reason).toBe('reconnect_required');
      expect(err.message).toContain('composioConnectedAccountId');
      expect(mockAssertComposioAccountActive).not.toHaveBeenCalled();
    });

    it('non-composio connector → falls through to the legacy path', async () => {
      stubGetConnectorConfig(service, {
        connectorType: 'stripe', // not composio_managed in catalog
        config: {},
      });
      stubGetCredentialRecord(service, {
        connectorId: COMPOSIO_CONNECTOR,
        tenantId: COMPOSIO_TENANT,
        flowKind: 'static_oauth',
        secretName: 'connector-tenant-1-stripe-1',
        scopes: ['stripe.read'],
        expiresAtEpochSec: Math.floor(Date.now() / 1000) + 3600,
        updatedAtEpochSec: Math.floor(Date.now() / 1000),
        extra: {},
      });
      mockGetConnectorCredential.mockResolvedValue({
        accessToken: 'legacy-token',
        refreshToken: 'legacy-refresh',
        scopes: ['stripe.read'],
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      } as never);

      const creds = await service.getCredentials(COMPOSIO_TENANT, COMPOSIO_CONNECTOR);

      expect(creds.flowKind).toBe('static_oauth');
      expect(creds.accessToken).toBe('legacy-token');
      // Composio path must NOT fire for non-composio connectors.
      expect(mockAssertComposioAccountActive).not.toHaveBeenCalled();
    });
  });

  describe('revokeCredentials', () => {
    it('composio_managed → calls deleteComposioConnectedAccount AND the local DELETE', async () => {
      stubGetConnectorConfig(service, {
        connectorType: 'google_mail',
        config: { composioConnectedAccountId: COMPOSIO_ACCOUNT },
      });
      mockDeleteComposioConnectedAccount.mockResolvedValue(undefined);
      const fakeQuery = jest.fn().mockResolvedValue({ rows: [] });
      mockWithTenantScope.mockImplementation(async (_tenantId, cb) => {
        return cb({ query: fakeQuery } as never);
      });

      await service.revokeCredentials(COMPOSIO_TENANT, COMPOSIO_CONNECTOR);

      expect(mockDeleteComposioConnectedAccount).toHaveBeenCalledWith(COMPOSIO_ACCOUNT);
      expect(fakeQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM connector_credentials'),
        [COMPOSIO_CONNECTOR],
      );
    });

    it('Composio delete failure is non-fatal — local DELETE still runs', async () => {
      stubGetConnectorConfig(service, {
        connectorType: 'google_mail',
        config: { composioConnectedAccountId: COMPOSIO_ACCOUNT },
      });
      mockDeleteComposioConnectedAccount.mockRejectedValue(new Error('composio 503'));
      const fakeQuery = jest.fn().mockResolvedValue({ rows: [] });
      mockWithTenantScope.mockImplementation(async (_tenantId, cb) => {
        return cb({ query: fakeQuery } as never);
      });

      await expect(
        service.revokeCredentials(COMPOSIO_TENANT, COMPOSIO_CONNECTOR),
      ).resolves.toBeUndefined();
      expect(fakeQuery).toHaveBeenCalled();
    });

    it('non-composio connector → Composio delete is NOT called', async () => {
      stubGetConnectorConfig(service, {
        connectorType: 'stripe',
        config: {},
      });
      const fakeQuery = jest.fn().mockResolvedValue({ rows: [] });
      mockWithTenantScope.mockImplementation(async (_tenantId, cb) => {
        return cb({ query: fakeQuery } as never);
      });

      await service.revokeCredentials(COMPOSIO_TENANT, COMPOSIO_CONNECTOR);

      expect(mockDeleteComposioConnectedAccount).not.toHaveBeenCalled();
      expect(fakeQuery).toHaveBeenCalled();
    });
  });

  describe('storeCredentials', () => {
    it('composio_managed flowKind → no-op (no SM write, no DB write)', async () => {
      const fakeQuery = jest.fn().mockResolvedValue({ rows: [] });
      mockWithTenantScope.mockImplementation(async (_tenantId, cb) => {
        return cb({ query: fakeQuery } as never);
      });

      await service.storeCredentials(
        COMPOSIO_TENANT,
        COMPOSIO_CONNECTOR,
        'composio_managed',
        { accessToken: 'should-not-be-stored' } as never,
      );

      expect(fakeQuery).not.toHaveBeenCalled();
    });
  });
});
