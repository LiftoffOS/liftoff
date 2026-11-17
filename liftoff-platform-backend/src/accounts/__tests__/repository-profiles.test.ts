// findProfilesByIds must read through withTenantScope.
//
// It joins tenant_members, which migration 200 leaves under RLS (only accounts
// is on the platform-global exclusion list) and migration 287 FORCEs. On a raw
// pool the policy evaluates current_setting('app.current_tenant_id') with
// nothing set and the statement dies with 42704 — which is how this shipped to
// prod and put the workforce-service facepile poll into a 500 loop.
//
// The router test above this mocks the repository wholesale, so nothing
// exercised the query itself. This does.

const mockTenantScopedQuery = jest.fn();
const mockRawPoolQuery = jest.fn();
const mockWithTenantScope = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockRawPoolQuery(...args) }),
  withTenantScope: (tenantId: string, cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) => {
    mockWithTenantScope(tenantId);
    return cb({ query: (...args: unknown[]) => mockTenantScopedQuery(...args) });
  },
}));

jest.mock('../../infrastructure/logging');

import { AccountRepository } from '../repository';

describe('AccountRepository.findProfilesByIds', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const ACCOUNT = '22222222-2222-2222-2222-222222222222';
  let repository: AccountRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new AccountRepository();
    mockTenantScopedQuery.mockResolvedValue({ rows: [] });
  });

  it('runs under withTenantScope for the requested tenant, never the raw pool', async () => {
    await repository.findProfilesByIds(TENANT, [ACCOUNT]);

    expect(mockWithTenantScope).toHaveBeenCalledWith(TENANT);
    expect(mockTenantScopedQuery).toHaveBeenCalledTimes(1);
    // The raw pool is what produces the 42704.
    expect(mockRawPoolQuery).not.toHaveBeenCalled();
  });

  it('still joins tenant_members so a leaked token cannot read outside the workspace', async () => {
    await repository.findProfilesByIds(TENANT, [ACCOUNT]);

    const sql = mockTenantScopedQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/JOIN\s+tenant_members\s+tm/);
    expect(mockTenantScopedQuery.mock.calls[0][1]).toEqual([[ACCOUNT], TENANT]);
  });

  it('maps rows to the profile shape the facepile consumes', async () => {
    mockTenantScopedQuery.mockResolvedValue({
      rows: [{
        id: ACCOUNT,
        first_name: 'Ada',
        last_name: null,
        email: 'ada@example.com',
        avatar_url: null,
        role: 'member',
      }],
    });

    const profiles = await repository.findProfilesByIds(TENANT, [ACCOUNT]);

    expect(profiles).toEqual([{
      accountId: ACCOUNT,
      firstName: 'Ada',
      lastName: null,
      email: 'ada@example.com',
      avatarUrl: null,
      // The tenant role rides the profile, read live from tenant_members.
      role: 'member',
    }]);
  });

  it('short-circuits an empty id list without touching the database', async () => {
    expect(await repository.findProfilesByIds(TENANT, [])).toEqual([]);
    expect(mockWithTenantScope).not.toHaveBeenCalled();
    expect(mockTenantScopedQuery).not.toHaveBeenCalled();
  });
});
