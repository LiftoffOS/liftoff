// resolveBindings: a type takes the workspace's first ACTIVE connection of
// it; a named connection is kept whatever its status, so a re-binding never
// swaps a team onto another connection of the same type; nothing of the type
// means pending; peers and collaborators resolve to peer entries or are
// reported unresolved.

const mockListConnectors = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  listConnectorsForTenant: (...a: unknown[]) => mockListConnectors(...a),
}));
const mockGetCollaborator = jest.fn();
jest.mock('../../external-agents/service', () => ({
  externalAgentService: { get: (...a: unknown[]) => mockGetCollaborator(...a) },
}));
const mockGetTeam = jest.fn();
jest.mock('../../internal-agents/service', () => ({
  internalAgentService: { getById: (...a: unknown[]) => mockGetTeam(...a) },
}));
const mockValidate = jest.fn(async (integrations: unknown[]) => integrations);
jest.mock('../../internal-agents/integration-validator', () => ({
  validateIntegrationsArray: (...a: unknown[]) => (mockValidate as unknown as (...x: unknown[]) => unknown)(...a),
}));

import { resolveBindings } from '../bindings';

const TENANT = '22222222-2222-2222-2222-222222222222';
const AGENT = 'a0000000-0000-0000-0000-000000000001';
const PEER = 'a0000000-0000-0000-0000-000000000002';
const COLLAB = 'c0000000-0000-0000-0000-000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  mockListConnectors.mockResolvedValue([
    { id: 'gm-1', type: 'google_mail', status: 'active' },
    { id: 'gm-2', type: 'google_mail', status: 'active' },
    { id: 'sl-1', type: 'slack', status: 'needs_reconnect' },
  ]);
});

describe('resolveBindings', () => {
  it('a type alone takes the first active connection of that type', async () => {
    const r = await resolveBindings(TENANT, AGENT, [{ kind: 'connector', type: 'google_mail', selectedObjects: ['INBOX'] }], 'acct');
    expect(r.integrations).toEqual([{ id: 'gm-1', type: 'google_mail', selectedObjects: ['INBOX'] }]);
    expect(r.pendingIntegrations).toEqual([]);
    expect(mockListConnectors).toHaveBeenCalledWith(TENANT, 'acct');
  });

  it('a named connection is kept, even when it is not the first of its type and even when it needs a reconnect', async () => {
    const r = await resolveBindings(TENANT, AGENT, [
      { kind: 'connector', type: 'google_mail', connectorId: 'gm-2' },
      { kind: 'connector', type: 'slack', connectorId: 'sl-1' },
    ], 'acct');
    expect(r.integrations).toEqual([
      { id: 'gm-2', type: 'google_mail', selectedObjects: [] },
      { id: 'sl-1', type: 'slack', selectedObjects: [] },
    ]);
    expect(r.pendingIntegrations).toEqual([]);
  });

  it('a named connection the workspace no longer has falls back to the type rule', async () => {
    const r = await resolveBindings(TENANT, AGENT, [
      { kind: 'connector', type: 'google_mail', connectorId: 'gm-gone' },
      { kind: 'connector', type: 'slack', connectorId: 'sl-gone' },
    ], 'acct');
    expect(r.integrations).toEqual([{ id: 'gm-1', type: 'google_mail', selectedObjects: [] }]);
    // No ACTIVE slack connection: pending, not bound to the reconnect-needed one.
    expect(r.pendingIntegrations).toEqual(['slack']);
  });

  it('a type with nothing connected is pending', async () => {
    const r = await resolveBindings(TENANT, AGENT, [{ kind: 'connector', type: 'hubspot' }], 'acct');
    expect(r.integrations).toEqual([]);
    expect(r.pendingIntegrations).toEqual(['hubspot']);
  });

  it('collaborators and peer teams become peer entries; unknown ids and the team itself are unresolved', async () => {
    mockGetCollaborator.mockImplementation(async (id: string) => (id === COLLAB ? { id: COLLAB, name: 'Billing' } : null));
    mockGetTeam.mockImplementation(async (id: string) => (id === PEER ? { id: PEER } : null));
    const r = await resolveBindings(TENANT, AGENT, [
      { kind: 'collaborator', id: COLLAB },
      { kind: 'collaborator', id: 'c0000000-0000-0000-0000-000000000009' },
      { kind: 'team', id: PEER },
      { kind: 'team', id: AGENT },
      { kind: 'team', id: 'a0000000-0000-0000-0000-000000000009' },
    ], 'acct');
    expect(r.integrations).toEqual([
      { id: COLLAB, type: 'external_agent', selectedObjects: [] },
      { id: PEER, type: 'internal_agent', selectedObjects: [] },
    ]);
    expect(r.unresolved).toEqual(['c0000000-0000-0000-0000-000000000009', AGENT, 'a0000000-0000-0000-0000-000000000009']);
    expect(mockListConnectors).not.toHaveBeenCalled();
    expect(mockValidate).toHaveBeenCalledWith(r.integrations, { tenantId: TENANT, agentId: AGENT });
  });
});
