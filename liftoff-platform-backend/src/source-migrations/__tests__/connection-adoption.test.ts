// Importing a connector type the workspace already has.
//
// Someone switching from OpenClaw very often already uses Liftoff, with Slack
// or GitHub connected and working. The import created a placeholder anyway, so
// the tenant ended up with TWO connectors of the same type: the real one, and a
// credential-less row in `error` marked source_import.
//
// That broke the funnel in a way reconnecting could not fix. The card offered
// Reconnect for the placeholder, the connector's setup flow healed the ORIGINAL
// connector, and the placeholder stayed in `error` forever. The
// card never cleared and the build gate never let go, because there was nothing
// wrong with the connector the person kept reconnecting.
//
// Adopting is also simply correct: being asked to reconnect an account that is
// connected and working is a question with no right answer.

import { materializeCatalogPlaceholders, materializeMcpPlaceholders } from '../connections';
import { sourceMigrationRepository as repo } from '../repository';
import * as client from '../../connectors/connector-service-client';

jest.mock('../repository');
jest.mock('../../connectors/connector-service-client');

const mockRepo = repo as jest.Mocked<typeof repo>;
const mockClient = client as jest.Mocked<typeof client>;

const CTX = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  migrationId: '33333333-3333-4333-8333-333333333333',
  source: 'openclaw',
};

const REQUIREMENT = { sourceRef: 'channel:slack', connectorType: 'slack' };

beforeEach(() => {
  jest.clearAllMocks();
  mockRepo.upsertConnection.mockResolvedValue({
    id: 'row-1',
    sourceRef: 'channel:slack',
    connectorType: 'slack',
    connectorId: null,
    status: 'placeholder_pending',
  } as never);
  mockRepo.attachConnectorId.mockResolvedValue(undefined as never);
  mockClient.createImportPlaceholders.mockResolvedValue({
    connectors: [{ id: 'new-placeholder', type: 'slack' }],
  } as never);
});

describe('a connector type the workspace already has', () => {
  it('adopts the existing connector instead of creating a second one', async () => {
    mockClient.listConnectorsForTenant.mockResolvedValue([
      { id: 'real-slack', type: 'slack', status: 'active' },
    ]);

    const result = await materializeCatalogPlaceholders(CTX, [REQUIREMENT]);

    expect(mockClient.createImportPlaceholders).not.toHaveBeenCalled();
    expect(mockRepo.attachConnectorId).toHaveBeenCalledWith(CTX.tenantId, 'row-1', {
      connectorId: 'real-slack',
      status: 'active',
    });
    expect(result.created[0]).toMatchObject({ connectorId: 'real-slack', status: 'active' });
  });

  it('adopts a broken existing connector as needing reconnection', async () => {
    // Still adopted rather than duplicated: reconnecting THIS row is an action
    // that works, and it is the row the setup flow will heal.
    mockClient.listConnectorsForTenant.mockResolvedValue([
      { id: 'real-slack', type: 'slack', status: 'error' },
    ]);

    const result = await materializeCatalogPlaceholders(CTX, [REQUIREMENT]);

    expect(mockClient.createImportPlaceholders).not.toHaveBeenCalled();
    expect(result.created[0]).toMatchObject({
      connectorId: 'real-slack',
      status: 'needs_reconnect',
    });
  });

  it('prefers the active connector when the type has more than one', async () => {
    mockClient.listConnectorsForTenant.mockResolvedValue([
      { id: 'stale-slack', type: 'slack', status: 'error' },
      { id: 'real-slack', type: 'slack', status: 'active' },
    ]);

    const result = await materializeCatalogPlaceholders(CTX, [REQUIREMENT]);
    expect(result.created[0]).toMatchObject({ connectorId: 'real-slack', status: 'active' });
  });
});

describe('a migration already bound to a placeholder', () => {
  // Adoption alone only helped migrations created after it shipped. Anyone
  // already part-way through kept pointing at the placeholder they were given,
  // so the card kept asking for a reconnect that could never land.
  beforeEach(() => {
    mockRepo.upsertConnection.mockResolvedValue({
      id: 'row-1',
      sourceRef: 'channel:slack',
      connectorType: 'slack',
      connectorId: 'dead-placeholder',
      status: 'needs_reconnect',
    } as never);
  });

  it('re-binds to the working connector of the same type', async () => {
    mockClient.listConnectorsForTenant.mockResolvedValue([
      { id: 'dead-placeholder', type: 'slack', status: 'error' },
      { id: 'real-slack', type: 'slack', status: 'active' },
    ]);

    const result = await materializeCatalogPlaceholders(CTX, [REQUIREMENT]);

    expect(mockRepo.attachConnectorId).toHaveBeenCalledWith(CTX.tenantId, 'row-1', {
      connectorId: 'real-slack',
      status: 'active',
    });
    expect(result.created[0]).toMatchObject({ connectorId: 'real-slack', status: 'active' });
  });

  it('leaves a row alone when the connector it points at works', async () => {
    // Nothing to heal. Re-binding here would move the import off the exact
    // account the person reconnected onto a different one of the same type.
    mockClient.listConnectorsForTenant.mockResolvedValue([
      { id: 'dead-placeholder', type: 'slack', status: 'active' },
      { id: 'other-slack', type: 'slack', status: 'active' },
    ]);

    await materializeCatalogPlaceholders(CTX, [REQUIREMENT]);
    expect(mockRepo.attachConnectorId).not.toHaveBeenCalled();
  });

  it('leaves a row alone when no working connector of that type exists', async () => {
    mockClient.listConnectorsForTenant.mockResolvedValue([
      { id: 'dead-placeholder', type: 'slack', status: 'error' },
    ]);

    await materializeCatalogPlaceholders(CTX, [REQUIREMENT]);
    expect(mockRepo.attachConnectorId).not.toHaveBeenCalled();
  });
});

describe('an MCP server the workspace already has', () => {
  // connector-service enforces UNIQUE (tenant, type, name). Importing a server
  // the workspace already knows about failed with a duplicate-key 500, so the
  // placeholder was never created and the connection stayed
  // `placeholder_pending` — a status that blocks the build and renders no card.
  // Importing the same server from a second source was enough to reach it.
  const MCP = { sourceRef: 'mcp:reporting', name: 'reporting', url: 'https://mcp.example.com/x' };

  beforeEach(() => {
    mockRepo.upsertConnection.mockResolvedValue({
      id: 'row-mcp',
      sourceRef: MCP.sourceRef,
      connectorType: 'custom_mcp_server',
      connectorId: null,
      status: 'placeholder_pending',
    } as never);
  });

  it('adopts it instead of failing on the duplicate name', async () => {
    mockClient.listConnectorsForTenant.mockResolvedValue([
      { id: 'existing-mcp', type: 'custom_mcp_server', name: 'reporting', status: 'active' },
    ]);

    const out = await materializeMcpPlaceholders(CTX, [MCP as never]);

    expect(mockClient.createImportPlaceholders).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ connectorId: 'existing-mcp', status: 'active' });
  });

  it('creates one when the workspace has no server by that name', async () => {
    mockClient.listConnectorsForTenant.mockResolvedValue([
      { id: 'other-mcp', type: 'custom_mcp_server', name: 'something-else', status: 'active' },
    ]);

    await materializeMcpPlaceholders(CTX, [MCP as never]);
    expect(mockClient.createImportPlaceholders).toHaveBeenCalled();
  });
});

describe('a connector type the workspace does not have', () => {
  it('creates the placeholder', async () => {
    mockClient.listConnectorsForTenant.mockResolvedValue([
      { id: 'real-github', type: 'github', status: 'active' },
    ]);

    await materializeCatalogPlaceholders(CTX, [REQUIREMENT]);
    expect(mockClient.createImportPlaceholders).toHaveBeenCalled();
  });

  it('still creates the placeholder when the existing connectors cannot be read', async () => {
    // A duplicate is recoverable. A failed import is not.
    mockClient.listConnectorsForTenant.mockRejectedValue(new Error('service down'));

    await materializeCatalogPlaceholders(CTX, [REQUIREMENT]);
    expect(mockClient.createImportPlaceholders).toHaveBeenCalled();
  });
});
