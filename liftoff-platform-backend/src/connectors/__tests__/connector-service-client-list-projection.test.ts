// listConnectorsForTenant's projection: the identity and state every caller
// read before, plus the two fields the workspace export needs and nothing
// else of `config`, which holds install ids and account labels that must not
// be serialized.

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn().mockRejectedValue(new Error('no metadata server')),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { listConnectorsForTenant } from '../connector-service-client';

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.CONNECTOR_SERVICE_URL = 'https://connectors.internal';
});

it('carries installState and createdAt, and no other config field', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ connectors: [
    { id: 'c-1', tenantId: 't', type: 'github', name: 'GitHub (123)', status: 'pending',
      config: { installState: 'awaiting_org_approval', installationId: 991, awaitingOrgLogin: 'acme', connectedAccountLabel: 'ops@acme' },
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z', apiKeyHint: 'sk-…' },
    { id: 'c-2', type: 'slack', name: 'Slack', status: 'active', config: {}, createdAt: '2026-08-03T00:00:00.000Z' },
    { id: 'c-3', type: 'custom_mcp_server', name: 'Docs', status: 'active', config: null, created_at: '2026-08-04T00:00:00.000Z' },
  ] }) });

  const rows = await listConnectorsForTenant('t', 'acc');
  expect(rows).toEqual([
    { id: 'c-1', type: 'github', name: 'GitHub (123)', status: 'pending', installState: 'awaiting_org_approval', createdAt: '2026-08-01T00:00:00.000Z' },
    { id: 'c-2', type: 'slack', name: 'Slack', status: 'active', installState: null, createdAt: '2026-08-03T00:00:00.000Z' },
    { id: 'c-3', type: 'custom_mcp_server', name: 'Docs', status: 'active', installState: null, createdAt: '2026-08-04T00:00:00.000Z' },
  ]);
  const text = JSON.stringify(rows);
  for (const forbidden of ['installationId', '991', 'awaitingOrgLogin', 'connectedAccountLabel', 'ops@acme', 'apiKeyHint', 'config']) {
    expect(text).not.toContain(forbidden);
  }
});

it('still throws on a non-2xx', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
  await expect(listConnectorsForTenant('t', 'acc')).rejects.toThrow(/listConnectorsForTenant failed: 500/);
});
