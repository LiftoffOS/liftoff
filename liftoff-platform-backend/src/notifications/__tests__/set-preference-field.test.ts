// Unit test for the SQL setPreferenceField helper (plan §7f verification:
// "setPreferenceField(['notificationTypes','taskUpdates'], false) → other type
// toggles still present"). The plan's correctness claim hinges on jsonb_set
// being path-targeted rather than a shallow merge — we verify the SQL string
// uses jsonb_set with the path array.

import { AccountRepository } from '../../accounts/repository';

const queryMock = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: queryMock }),
  withAdminScope: jest.fn(),
  withTenantScope: jest.fn(),
}));

beforeEach(() => {
  queryMock.mockClear();
});

describe('AccountRepository.setPreferenceField', () => {
  const repo = new AccountRepository();
  const ACCT_ID = '11111111-2222-3333-4444-555555555555';

  it('uses jsonb_set with the path-array binding (so siblings are preserved)', async () => {
    await repo.setPreferenceField(ACCT_ID, ['notificationTypes', 'taskUpdates'], false);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/jsonb_set/i);
    expect(sql).toMatch(/\$2::text\[\]/);
    // path expressed as Postgres text[] literal: {notificationTypes,taskUpdates}
    expect(params[1]).toBe('{notificationTypes,taskUpdates}');
    expect(params[2]).toBe(JSON.stringify(false));
    expect(params[0]).toBe(ACCT_ID);
  });

  it('writes a top-level newsletter flag with a single-element path', async () => {
    await repo.setPreferenceField(ACCT_ID, ['newsletter'], false);
    const [, params] = queryMock.mock.calls[0];
    expect(params[1]).toBe('{newsletter}');
  });

  it('writes notificationFrequency=none at top level', async () => {
    await repo.setPreferenceField(ACCT_ID, ['notificationFrequency'], 'none');
    const [, params] = queryMock.mock.calls[0];
    expect(params[1]).toBe('{notificationFrequency}');
    expect(params[2]).toBe(JSON.stringify('none'));
  });
});
