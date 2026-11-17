// Connections: the Connections page's read; the connect kinds a conversation
// may start (anything with a key or token is the page's, D5); the GitHub App
// and IAM-grant flows; disconnect verified under the tenant; custom MCP
// servers and tunnels. Every write is owner/admin and audited.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockClient = {
  getCatalog: jest.fn(),
  listConnectorsForTenant: jest.fn(),
  getConnectorHealthStats: jest.fn(),
  getConnectorForTenant: jest.fn(),
  deleteConnectorForTenant: jest.fn(),
  startOAuthConnect: jest.fn(),
  listGithubInstallTargets: jest.fn(),
  startGithubInstall: jest.fn(),
  startIamGrantConnect: jest.fn(),
  verifyIamGrantConnect: jest.fn(),
};
jest.mock('../../connectors/connector-service-client', () => mockClient);

const mockTeamsUrl = jest.fn();
jest.mock('../../agent-chat/teams-adapter/admin-routes', () => ({
  buildTeamsConnectUrl: (...a: unknown[]) => mockTeamsUrl(...a),
}));

const mockCustom = { list: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), rediscover: jest.fn() };
jest.mock('../../custom-mcp-servers/service', () => ({ customMcpServerService: mockCustom }));

const mockTunnels = { listDeployments: jest.fn(), listRoutes: jest.fn() };
jest.mock('../../tunnels/service', () => ({ tunnelsService: mockTunnels }));

import { logAudit } from '../../infrastructure/logging';
import { PermissionDenied, type Actor } from '../actor';
import {
  customMcpConnect, customMcpDelete, customMcpRediscover, customMcpTools, customMcpUpdate,
  disconnect, listConnections, previewConnect, previewDisconnect, startConnect, tunnelsState, verifyConnect,
} from '../connections';

const TENANT = '22222222-2222-2222-2222-222222222222';
const actor = (role: Actor['role'] = 'admin'): Actor => ({ tenantId: TENANT, accountId: 'acct-1', role, displayName: 'Ada', surface: 'liftoff' });

const CATALOG = {
  connectors: [
    { type: 'google_mail', displayName: 'Gmail', category: 'email', status: 'available', auth: { kind: 'static_oauth' } },
    { type: 'zendesk', displayName: 'Zendesk', category: 'support', status: 'available', auth: { kind: 'static_oauth' } },
    { type: 'github', displayName: 'GitHub', category: 'dev', status: 'available', auth: { kind: 'github_app' } },
    { type: 'google_bigquery', displayName: 'BigQuery', category: 'data', status: 'available', auth: { kind: 'iam_grant' } },
    { type: 'stripe', displayName: 'Stripe', category: 'finance', status: 'available', auth: { kind: 'api_key' } },
    { type: 'linear', displayName: 'Linear', category: 'dev', status: 'coming_soon', statusReason: 'Linear is coming soon.', auth: { kind: 'static_oauth' } },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.getCatalog.mockResolvedValue(CATALOG);
  mockClient.listConnectorsForTenant.mockResolvedValue([{ id: 'gm-1', type: 'google_mail', name: null, status: 'active' }]);
  mockClient.getConnectorHealthStats.mockResolvedValue({ totalConnectors: 1, healthyConnectors: 1, degradedConnectors: 0, errorConnectors: 0, activeIncidents: 0 });
  mockCustom.list.mockResolvedValue([]);
});

describe('listConnections', () => {
  it('any member reads the page: connected with names from the catalog, available with whether it starts here, health, custom servers', async () => {
    mockCustom.list.mockResolvedValueOnce([{ id: 'm1', name: 'Ops', deliveryMode: 'public_url', endpointUrl: 'https://mcp.example.com/sse', rawMcpTools: [{ name: 'a' }] }]);
    const view = await listConnections(actor('viewer'));
    expect(view.connected).toEqual([{ id: 'gm-1', type: 'google_mail', name: 'Gmail', status: 'active' }]);
    const byType = Object.fromEntries(view.available.map((a) => [a.type, a]));
    expect(byType.google_mail.startableHere).toBe(true);
    expect(byType.github.startableHere).toBe(true);
    expect(byType.google_bigquery.startableHere).toBe(true);
    expect(byType.stripe.startableHere).toBe(false);
    expect(byType.linear).toBeUndefined();
    expect(view.health?.healthyConnectors).toBe(1);
    expect(view.customMcpServers).toEqual([{ id: 'm1', name: 'Ops', deliveryMode: 'public_url', endpointHost: 'mcp.example.com', toolCount: 1 }]);
  });

  it('a health read that fails leaves health null rather than failing the page', async () => {
    mockClient.getConnectorHealthStats.mockRejectedValueOnce(new Error('down'));
    expect((await listConnections(actor())).health).toBeNull();
  });
});

describe('previewConnect', () => {
  it('is owner/admin', async () => {
    await expect(previewConnect(actor('member'), 'google_mail')).rejects.toBeInstanceOf(PermissionDenied);
  });

  it('names the kind: OAuth (with the subdomain step for Zendesk), the GitHub App with its targets, an IAM grant with its fields, Teams', async () => {
    expect(await previewConnect(actor(), 'google_mail')).toEqual({ kind: 'oauth', connectorType: 'google_mail', name: 'Gmail' });
    expect(await previewConnect(actor(), 'zendesk')).toMatchObject({ kind: 'oauth', subdomainRequired: { suffix: '.zendesk.com' } });
    mockClient.listGithubInstallTargets.mockResolvedValueOnce([{ login: 'acme', id: 7, type: 'Organization' }]);
    expect(await previewConnect(actor(), 'github')).toMatchObject({ kind: 'github_app', targets: [{ login: 'acme' }] });
    expect(await previewConnect(actor(), 'google_bigquery')).toEqual({ kind: 'iam_grant', connectorType: 'google_bigquery', name: 'BigQuery', fields: ['projectId', 'dataset'] });
    expect(await previewConnect(actor(), 'microsoft_teams')).toMatchObject({ kind: 'microsoft_teams' });
  });

  it('refuses a key or token connector with the page, an unknown one, and one that is not available', async () => {
    expect(await previewConnect(actor(), 'stripe')).toMatchObject({ refused: 'page_only', page: expect.stringContaining('/dashboard/connections') });
    expect(await previewConnect(actor(), 'nope')).toMatchObject({ refused: 'unknown_connector' });
    expect(await previewConnect(actor(), 'linear')).toEqual({ refused: 'unavailable', message: 'Linear is coming soon.' });
  });
});

describe('startConnect', () => {
  it('OAuth: the vendor link, with the subdomain when required, reconnecting in place when asked; audited', async () => {
    mockClient.startOAuthConnect.mockResolvedValue({ authUrl: 'https://vendor/auth' });
    const r = await startConnect(actor(), 'google_mail', { reconnectConnectorId: 'gm-1' });
    expect(r).toMatchObject({ kind: 'oauth', link: 'https://vendor/auth' });
    expect(mockClient.startOAuthConnect).toHaveBeenCalledWith(TENANT, 'acct-1', 'google_mail', expect.objectContaining({ connectorId: 'gm-1', returnUrl: expect.stringContaining('/oauth/callback') }));
    expect(logAudit).toHaveBeenCalledWith('connection.start', expect.objectContaining({ userId: 'acct-1', operation: 'liftoff' }), expect.objectContaining({ connectorType: 'google_mail', reconnect: true }));

    expect(await startConnect(actor(), 'zendesk')).toMatchObject({ refused: 'validation' });
    await startConnect(actor(), 'zendesk', { subdomain: 'acme' });
    expect(mockClient.startOAuthConnect).toHaveBeenLastCalledWith(TENANT, 'acct-1', 'zendesk', expect.objectContaining({ dynamicUrlParams: { subdomain: 'acme' } }));
  });

  it('GitHub: needs the target, then the install link', async () => {
    mockClient.listGithubInstallTargets.mockResolvedValue([]);
    expect(await startConnect(actor(), 'github')).toMatchObject({ refused: 'validation' });
    mockClient.startGithubInstall.mockResolvedValueOnce({ installUrl: 'https://github.com/apps/liftoff/installations/new' });
    const r = await startConnect(actor(), 'github', { targetLogin: 'acme', targetId: 7 });
    expect(r).toMatchObject({ kind: 'github_app', targetLogin: 'acme', link: expect.stringContaining('github.com') });
    expect(mockClient.startGithubInstall).toHaveBeenCalledWith(TENANT, 'acct-1', expect.objectContaining({ targetLogin: 'acme', targetId: 7 }));
  });

  it('IAM grant: provisions and returns the grant steps; verify afterwards', async () => {
    expect(await startConnect(actor(), 'google_bigquery')).toMatchObject({ refused: 'validation' });
    mockClient.startIamGrantConnect.mockResolvedValueOnce({ connectorId: 'bq-1', serviceAccountEmail: 'sa@x.iam', grantInstructions: 'grant it', status: 'pending_grant' });
    const r = await startConnect(actor(), 'google_bigquery', { fields: { projectId: 'p1', dataset: 'd' } });
    expect(r).toMatchObject({ kind: 'iam_grant', connectorId: 'bq-1', status: 'pending_grant', serviceAccountEmail: 'sa@x.iam' });
    expect(mockClient.startIamGrantConnect).toHaveBeenCalledWith(TENANT, 'acct-1', '/api/connectors/bigquery', { projectId: 'p1', dataset: 'd' });
    mockClient.verifyIamGrantConnect.mockResolvedValueOnce({ connectorId: 'bq-1', status: 'active' });
    expect(await verifyConnect(actor(), 'google_bigquery', 'bq-1')).toEqual({ connectorId: 'bq-1', status: 'active' });
    expect(await verifyConnect(actor(), 'google_mail', 'gm-1')).toMatchObject({ refused: 'unknown_connector' });
  });

  it('Microsoft Teams: the administrator sign-in link, or not_configured', async () => {
    mockTeamsUrl.mockReturnValueOnce('https://login.microsoftonline.com/x');
    expect(await startConnect(actor(), 'microsoft_teams')).toMatchObject({ kind: 'microsoft_teams', link: 'https://login.microsoftonline.com/x' });
    mockTeamsUrl.mockReturnValueOnce(null);
    expect(await startConnect(actor(), 'microsoft_teams')).toMatchObject({ refused: 'not_configured' });
  });

  it('a page-only connector is refused before anything is started', async () => {
    expect(await startConnect(actor(), 'stripe')).toMatchObject({ refused: 'page_only' });
    expect(mockClient.startOAuthConnect).not.toHaveBeenCalled();
  });
});

describe('disconnect', () => {
  it('the preview carries the GitHub App caveat; the delete is verified under the tenant first', async () => {
    mockClient.getConnectorForTenant.mockResolvedValueOnce({ id: 'gh-1', type: 'github', name: 'GitHub', status: 'active', config: { installationId: 5 } });
    expect(await previewDisconnect(actor(), 'gh-1')).toMatchObject({ connector: { id: 'gh-1' }, githubAppCaveat: expect.stringContaining('does not uninstall') });
    mockClient.getConnectorForTenant.mockResolvedValueOnce({ id: 'gm-1', type: 'google_mail', status: 'active' });
    expect(await disconnect(actor(), 'gm-1')).toEqual({ disconnected: true, connectorType: 'google_mail' });
    expect(mockClient.getConnectorForTenant).toHaveBeenLastCalledWith(TENANT, 'acct-1', 'gm-1');
    expect(mockClient.deleteConnectorForTenant).toHaveBeenCalledWith('gm-1', 'acct-1');
    expect(logAudit).toHaveBeenCalledWith('connection.disconnect', expect.anything(), expect.objectContaining({ connectorId: 'gm-1' }));

    mockClient.getConnectorForTenant.mockResolvedValueOnce(null);
    expect(await disconnect(actor(), 'other-tenants')).toMatchObject({ refused: 'not_found' });
    expect(mockClient.deleteConnectorForTenant).toHaveBeenCalledTimes(1);
  });
});

describe('custom MCP servers', () => {
  const server = { id: 'm1', name: 'Ops', deliveryMode: 'public_url', endpointUrl: 'https://mcp.example.com/sse', authType: 'none', tunnelRouteId: null, connectorId: 'c1', rawMcpTools: [{ name: 'a', description: 'A' }] };

  it('connects a public tokenless server, updates, rediscovers, deletes; the tunnelled endpoint is the tunnel\'s', async () => {
    mockCustom.create.mockResolvedValueOnce(server);
    const created = await customMcpConnect(actor(), { name: 'Ops', endpointUrl: 'https://mcp.example.com/sse' });
    expect(created.server).toMatchObject({ id: 'm1', endpointHost: 'mcp.example.com', tools: [{ name: 'a', description: 'A' }] });
    expect(mockCustom.create).toHaveBeenCalledWith(TENANT, 'acct-1', { name: 'Ops', deliveryMode: 'public_url', endpointUrl: 'https://mcp.example.com/sse', authType: 'none' });

    mockCustom.get.mockResolvedValueOnce({ ...server, deliveryMode: 'tunneled' });
    expect(await customMcpUpdate(actor(), 'm1', { endpointUrl: 'https://elsewhere' })).toMatchObject({ refused: 'tunnelled' });
    mockCustom.get.mockResolvedValueOnce(server);
    mockCustom.update.mockResolvedValueOnce({ ...server, name: 'Ops 2' });
    expect(await customMcpUpdate(actor(), 'm1', { name: 'Ops 2' })).toMatchObject({ server: { name: 'Ops 2' } });

    mockCustom.get.mockResolvedValueOnce(server);
    expect(await customMcpTools(actor('viewer'), 'm1')).toMatchObject({ server: { tools: [{ name: 'a' }] } });
    mockCustom.rediscover.mockResolvedValueOnce(server);
    expect(await customMcpRediscover(actor(), 'm1')).toMatchObject({ server: { id: 'm1' } });
    mockCustom.delete.mockResolvedValueOnce(true);
    expect(await customMcpDelete(actor(), 'm1')).toEqual({ deleted: true });
    mockCustom.delete.mockResolvedValueOnce(false);
    expect(await customMcpDelete(actor(), 'm9')).toMatchObject({ refused: 'not_found' });
    expect((logAudit as jest.Mock).mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([
      'custom_mcp_server.created', 'custom_mcp_server.updated', 'custom_mcp_server.rediscovered', 'custom_mcp_server.deleted',
    ]));
  });

  it('every write is owner/admin', async () => {
    await expect(customMcpConnect(actor('member'), { name: 'x', endpointUrl: 'https://x' })).rejects.toBeInstanceOf(PermissionDenied);
    await expect(customMcpDelete(actor('member'), 'm1')).rejects.toBeInstanceOf(PermissionDenied);
    await expect(startConnect(actor('member'), 'google_mail')).rejects.toBeInstanceOf(PermissionDenied);
    await expect(disconnect(actor('member'), 'gm-1')).rejects.toBeInstanceOf(PermissionDenied);
  });
});

describe('tunnelsState', () => {
  it('groups routes under their deployment', async () => {
    mockTunnels.listDeployments.mockResolvedValueOnce([{ id: 'd1', name: 'Office', status: 'connected', lastSeenAt: null }]);
    mockTunnels.listRoutes.mockResolvedValueOnce([{ id: 'r1', deploymentId: 'd1', subdomain: 'crm', publicUrl: 'https://crm.t.example.com' }, { id: 'r2', deploymentId: 'other', subdomain: 'x', publicUrl: 'u' }]);
    expect(await tunnelsState(actor('viewer'))).toEqual({
      deployments: [{ id: 'd1', name: 'Office', status: 'connected', lastSeenAt: null, routes: [{ id: 'r1', subdomain: 'crm', publicUrl: 'https://crm.t.example.com' }] }],
    });
  });
});
