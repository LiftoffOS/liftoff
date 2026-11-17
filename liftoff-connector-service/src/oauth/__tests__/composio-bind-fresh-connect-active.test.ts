// Regression: a FRESH Composio connect must land status='active'.
//
// THE DEFECT. completeComposioConnection has four paths to a connector row:
//   (1) an existing composio row          -> updateConnectorStatus('active')
//   (2) adopt a migration-marked row      -> adoptMigrationMarkedConnector sets 'active'
//   (2b) adopt a legacy direct-OAuth row  -> same helper, 'active'
//   (3) fresh connect                     -> createConnector INSERTs 'pending'
//
// Only (3) never set a status. createConnector's 'pending' default is right for
// the api-key flow, which creates the row and activates it once the key
// verifies — but OAuth has no second step: by the time the bind runs,
// pollConnectedAccountActive has already confirmed the account is ACTIVE in
// Composio. So a first-ever Composio connect for a connector type authenticated
// fine, dispatched tools fine, and rendered NOWHERE, because the Connections
// page derives its tile from connectors.status (migration 024: active=Connected,
// error=Reconnect).
//
// It is easy to miss because it only bites a genuinely fresh connect.
// Everything adopted from legacy direct OAuth takes path (2b), and any later
// reconnect takes path (1) — both activate, so a reconnect silently "fixes" it.
// The symptom: a fresh connect completes, executes tools successfully, and
// never appears on /dashboard/connections.

const mockCreate = jest.fn();
const mockUpdateStatus = jest.fn();
const mockMergeConfig = jest.fn();

jest.mock('../connector-ops.js', () => ({
  findConnectorByTenantAndType: jest.fn().mockResolvedValue(null),
  findConnectorByTenantTypeAndExternalAccountId: jest.fn().mockResolvedValue(null),
  findMigrationMarkedConnector: jest.fn().mockResolvedValue(null),
  adoptMigrationMarkedConnector: jest.fn(),
  createConnectorReusingOnAccountConflict: (...a: unknown[]) => mockCreate(...a),
  getConnectorById: jest.fn().mockResolvedValue(null),
  updateConnectorStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  mergeConnectorConfig: (...a: unknown[]) => mockMergeConfig(...a),
  deleteOAuthState: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../composio-client.js', () => ({ getComposio: () => ({}) }));
jest.mock('../composio-trigger-arm.js', () => ({ ensureComposioTriggerArmed: jest.fn() }));
jest.mock('../identity-fetchers.js', () => ({
  extractComposioIdentity: jest.fn().mockResolvedValue({
    externalAccountId: 'zoho-acct-1',
    externalAccountLabel: 'Zoho CRM',
  }),
}));
jest.mock('../../events/publisher.js', () => ({ emitCredentialsStored: jest.fn() }));

import { completeComposioConnection } from '../composio-bind.js';

const FRESH_ROW = { id: 'connector-1', tenantId: 't1', type: 'zoho', status: 'pending' };

describe('fresh Composio connect → status active', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue(FRESH_ROW);
    // updateConnectorStatus echoes the status it was asked to set
    mockUpdateStatus.mockImplementation((_t: string, id: string, status: string) =>
      Promise.resolve({ ...FRESH_ROW, id, status }),
    );
    mockMergeConfig.mockResolvedValue(FRESH_ROW);
  });

  const run = () =>
    completeComposioConnection({
      state: 'state-1',
      oauthState: {
        tenantId: 't1',
        connectorType: 'zoho',
        redirectUri: 'https://example.test/cb',
      } as never,
      connectedAccount: { id: 'ca_1', status: 'ACTIVE' } as never,
      composioAuthConfigId: 'ac_1',
      source: 'callback',
    });

  it('activates the row a fresh connect just created', async () => {
    await run();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // The row is created 'pending' by createConnector; the bind must flip it.
    expect(mockUpdateStatus).toHaveBeenCalledWith('t1', 'connector-1', 'active');
  });

  it('never leaves a completed OAuth connect pending', async () => {
    await run();

    // Whatever path was taken, no call may settle the row on 'pending'. This is
    // the property that actually matters — asserting only the call above would
    // pass again if someone later re-introduced a pending write downstream.
    const statuses = mockUpdateStatus.mock.calls.map((c) => c[2]);
    expect(statuses).not.toContain('pending');
    expect(statuses).toContain('active');
  });

  it('returns the created connector id to the caller', async () => {
    await expect(run()).resolves.toEqual({ connectorId: 'connector-1' });
  });
});
