// Profiles are read and written under tenant scope; the upsert leaves a
// field alone when the caller did not send it and clears it on null, so two
// people editing different fields do not overwrite each other's.

const mockQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockQuery }) => unknown) => fn({ query: mockQuery })),
}));

import { withTenantScope } from '../../infrastructure/database';
import { listConnectionProfiles, upsertConnectionProfile } from '../connection-profiles';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => jest.clearAllMocks());

describe('listConnectionProfiles', () => {
  it('reads the tenant\'s profiles under tenant scope, keyed by connection id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { connection_id: 'c1', name: 'Mine', description: null },
      { connection_id: 'c2', name: null, description: 'Reviews PRs' },
    ] });
    const profiles = await listConnectionProfiles(TENANT_ID);
    expect(withTenantScope).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(String(mockQuery.mock.calls[0][0])).toContain('FROM coding_tool_connection_profiles');
    expect(mockQuery.mock.calls[0][1]).toEqual([TENANT_ID]);
    expect(profiles.get('c1')).toEqual({ name: 'Mine', description: null });
    expect(profiles.get('c2')).toEqual({ name: null, description: 'Reviews PRs' });
  });
});

describe('upsertConnectionProfile', () => {
  it('sends each field with a flag saying whether the caller set it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Mine', description: null }] });
    const out = await upsertConnectionProfile({ tenantId: TENANT_ID, connectionId: 'c1', updatedBy: 'acc-1', name: 'Mine' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('ON CONFLICT (connection_id) DO UPDATE');
    expect(params).toEqual(['c1', TENANT_ID, 'Mine', null, 'acc-1', true, false]);
    expect(out).toEqual({ name: 'Mine', description: null });
  });

  it('clears a field on null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ name: null, description: 'kept' }] });
    await upsertConnectionProfile({ tenantId: TENANT_ID, connectionId: 'c1', updatedBy: 'acc-1', name: null });
    expect(mockQuery.mock.calls[0][1]).toEqual(['c1', TENANT_ID, null, null, 'acc-1', true, false]);
  });
});
