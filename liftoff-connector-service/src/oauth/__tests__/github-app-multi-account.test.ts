// A GitHub App is installed per ACCOUNT. Personal account plus three orgs is
// four installations, each with its own id and its own repository selection.
//
// The first implementation resolved the row with
// `findUsableConnectorByTenantAndType(tenantId, 'github')` — one row per tenant
// per type. Installing to a second account would have merged its installation id
// onto the first account's row, leaving the first account silently back on the
// OAuth user token with nothing reporting it: writes would keep working and
// quietly go back to being authored by a person, which is the exact failure the
// App exists to fix.
//
// Not reachable yet only because the picker does not exist, so no one can
// install at all. These pin the resolution before it can be.

const mockFindByAccount = jest.fn();
const mockFindPending = jest.fn();
const mockFindUsable = jest.fn();
const mockCreate = jest.fn();
const mockMerge = jest.fn().mockResolvedValue(undefined);
const mockStatus = jest.fn().mockResolvedValue(undefined);

jest.mock('../connector-ops.js', () => ({
  findConnectorByTenantTypeAndExternalAccountId: (...a: unknown[]) => mockFindByAccount(...a),
  findUsableConnectorByTenantAndType: (...a: unknown[]) => mockFindUsable(...a),
  createConnectorReusingOnAccountConflict: (...a: unknown[]) => mockCreate(...a),
  mergeConnectorConfig: (...a: unknown[]) => mockMerge(...a),
  updateConnectorStatus: (...a: unknown[]) => mockStatus(...a),
  createConnector: jest.fn(),
  getConnectorById: jest.fn(),
}));
jest.mock('../github-app-pending.js', () => ({
  findTenantsAwaitingInstall: (...a: unknown[]) => mockFindPending(...a),
}));
jest.mock('../github-app.js', () => ({
  getInstallation: jest.fn().mockResolvedValue({
    id: 999, accountLogin: 'acme', accountId: 4242,
    accountType: 'Organization', repositorySelection: 'all',
  }),
  listInstallationRepositories: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../types.js', () => ({ CONNECTOR_DISPLAY_NAMES: { github: 'GitHub' } }));

import { completeGithubAppInstallation } from '../github-app-bind.js';

const run = () =>
  completeGithubAppInstallation({ installationId: 999, tenantId: 't1', source: 'callback' });

beforeEach(() => {
  jest.clearAllMocks();
  mockFindByAccount.mockResolvedValue(null);
  mockFindPending.mockResolvedValue([]);
  mockFindUsable.mockResolvedValue(null);
  mockCreate.mockResolvedValue({ id: 'new-row' });
});

describe('resolution precedence', () => {
  it('reuses the row already keyed to this GitHub account', async () => {
    // A re-install, a repository change, or a redelivered webhook must land
    // where it landed last time.
    mockFindByAccount.mockResolvedValue({ id: 'row-for-4242' });

    const out = await run();

    expect(out?.connectorId).toBe('row-for-4242');
    expect(mockMerge).toHaveBeenCalledWith('t1', 'row-for-4242', expect.anything());
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('adopts the row parked waiting for THIS org', async () => {
    // recordPendingInstallRequest wrote no account id, so the lookup above
    // cannot see it. Without this step an approved request would create a
    // second row and leave the pending card sitting there forever.
    mockFindPending.mockResolvedValue([{ tenantId: 't1', connectorId: 'pending-row' }]);

    expect((await run())?.connectorId).toBe('pending-row');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('ignores a pending row belonging to a DIFFERENT tenant', async () => {
    mockFindPending.mockResolvedValue([{ tenantId: 'someone-else', connectorId: 'not-ours' }]);

    expect((await run())?.connectorId).toBe('new-row');
  });

  it('upgrades a pre-App row in place, preserving its id', async () => {
    // The first install. Reusing the id is what keeps existing agent tool
    // aliases (`<type>-<id-prefix>__<fn>`) valid across the transition.
    mockFindUsable.mockResolvedValue({ id: 'legacy-row', config: {} });

    expect((await run())?.connectorId).toBe('legacy-row');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('a second account does not overwrite the first', () => {
  it('creates a new row when the only existing one belongs to another account', async () => {
    // THE REGRESSION. `personal` is already installed; installing to the org
    // must not merge onto it.
    mockFindUsable.mockResolvedValue({
      id: 'personal-row',
      config: { installationId: 111, externalAccountId: '777' },
    });

    const out = await run();

    expect(out?.connectorId).toBe('new-row');
    expect(mockMerge).not.toHaveBeenCalledWith('t1', 'personal-row', expect.anything());
  });

  it('does not adopt a row that already holds a DIFFERENT installation', async () => {
    mockFindUsable.mockResolvedValue({ id: 'other-row', config: { installationId: 111 } });

    expect((await run())?.connectorId).toBe('new-row');
  });

  it('names the new row after the account, since (tenant, type, name) is unique', async () => {
    await run();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'github', name: 'GitHub (acme)' }),
      '4242',
    );
  });

  it('writes externalAccountId, or the next install cannot find this row', async () => {
    // The key the whole scheme turns on. Without it, step 1 misses every time
    // and each re-install would create yet another row.
    await run();
    expect(mockCreate.mock.calls[0][0].config).toMatchObject({
      externalAccountId: '4242',
      externalAccountLabel: 'acme',
      installationId: 999,
    });
  });
});
