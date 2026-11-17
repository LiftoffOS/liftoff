// A billing suspension change reaches every tenant under the account as a
// republished entitlement snapshot: one version bump per tenant with no
// field changed, so the event carries billingSuspended from the joined truth.
// Fail-isolated per tenant, and never fatal: the TTL refresh stays the backstop.

const mockUpdate = jest.fn();
jest.mock('../../entitlements/service', () => ({
  EntitlementService: jest.fn().mockImplementation(() => ({ update: (...a: unknown[]) => mockUpdate(...a) })),
}));
const mockAdminQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ query: (...a: unknown[]) => mockAdminQuery(...a) })),
  getPool: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { publishBillingSuspensionChange } from '../billing-suspension-publisher';

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdate.mockResolvedValue({});
});

it('republishes the snapshot of every tenant under the account, bounded to that account', async () => {
  mockAdminQuery.mockResolvedValue({ rows: [{ tenant_id: 't-1' }, { tenant_id: 't-2' }] });
  await publishBillingSuspensionChange('acct-1', 'suspended', 'zero_prepaid_balance');
  expect(String(mockAdminQuery.mock.calls[0][0])).toMatch(/t\.account_id = \$1/);
  expect(mockAdminQuery.mock.calls[0][1]).toEqual(['acct-1']);
  expect(mockUpdate.mock.calls.map((c) => c[0])).toEqual(['t-1', 't-2']);
  expect(mockUpdate.mock.calls[0][1]).toEqual({});
});

it('one tenant failing does not strand the others, and a listing failure is logged, not thrown', async () => {
  mockAdminQuery.mockResolvedValue({ rows: [{ tenant_id: 't-1' }, { tenant_id: 't-2' }] });
  mockUpdate.mockRejectedValueOnce(new Error('rls'));
  await expect(publishBillingSuspensionChange('acct-1', 'unsuspended', 'prepaid_topped_up')).resolves.toBeUndefined();
  expect(mockUpdate).toHaveBeenCalledTimes(2);
  mockAdminQuery.mockRejectedValueOnce(new Error('db down'));
  await expect(publishBillingSuspensionChange('acct-1', 'suspended', 'payment_failed')).resolves.toBeUndefined();
});
