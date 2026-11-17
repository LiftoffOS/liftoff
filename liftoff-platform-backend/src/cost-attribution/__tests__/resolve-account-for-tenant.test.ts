// A tenant id that is not a uuid names no tenant. The ingesters resolve the
// account before advancing their cursor, and `tenants.id` is a uuid, so a
// label written into a TEXT tenant_id column used to raise 22P02 on every
// sweep and park cost attribution for every tenant behind it.

const query = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => query(...a) }),
  withAdminScope: jest.fn(),
  withTenantScope: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { resolveAccountIdForTenant } from '../repository';

beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [{ account_id: 'acct-1' }] }); });

describe('resolveAccountIdForTenant', () => {
  it('reads the account of a uuid tenant', async () => {
    expect(await resolveAccountIdForTenant('dd7d80bd-3b77-4677-817c-053fdb8668cd')).toBe('acct-1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM tenants WHERE id = $1'), ['dd7d80bd-3b77-4677-817c-053fdb8668cd']);
  });

  it('a value that is not a uuid names no tenant: null, and no query that would raise 22P02', async () => {
    for (const bad of ['dev-verify-apify', '', 'tenant-slug', 'dd7d80bd-61c0-49c9-bf57']) {
      expect(await resolveAccountIdForTenant(bad)).toBeNull();
    }
    expect(query).not.toHaveBeenCalled();
  });
});
