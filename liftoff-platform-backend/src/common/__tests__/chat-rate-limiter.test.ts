// Shared chat rate limiter — argument contract.
//
// The limiter fails open on a database fault, which is a deliberate
// availability trade. It must NOT fail open on a bad argument: the distill
// surface passed a Firebase uid as `accountId` from the day it shipped, every
// insert raised `invalid input syntax for type uuid`, and every request took
// the fail-open branch. The result was an unthrottled path into the most
// expensive LLM call in the product, reported once per request as a database
// error that read like infrastructure noise.

const mockQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(
    async (_tenantId: string, fn: (client: { query: typeof mockQuery }) => Promise<unknown>) =>
      fn({ query: mockQuery }),
  ),
}));

const mockLogError = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: mockLogError, debug: jest.fn() },
}));

import { checkAndIncrementChatRateLimit } from '../chat-rate-limiter';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const FIREBASE_UID = 'F6wbR2SXrBhe6aMT398J38pNzb53';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('argument contract', () => {
  it('rejects a Firebase uid passed as accountId instead of failing open', async () => {
    await expect(
      checkAndIncrementChatRateLimit({
        tableName: 'distill_rate_limit_events',
        tenantId: TENANT_ID,
        accountId: FIREBASE_UID,
      }),
    ).rejects.toThrow(/accountId must be a UUID/);

    // The decisive part: it must not have silently allowed the request.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID tenantId', async () => {
    await expect(
      checkAndIncrementChatRateLimit({
        tableName: 'distill_rate_limit_events',
        tenantId: 'not-a-uuid',
        accountId: ACCOUNT_ID,
      }),
    ).rejects.toThrow(/tenantId must be a UUID/);
  });

  it('rejects an unknown ledger table', async () => {
    await expect(
      checkAndIncrementChatRateLimit({
        tableName: 'some_other_table',
        tenantId: TENANT_ID,
        accountId: ACCOUNT_ID,
      }),
    ).rejects.toThrow(/unknown table/);
  });

  it('accepts well-formed identifiers', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        tenant_minute: '1', tenant_hour: '1', tenant_day: '1',
        user_minute: '1', user_hour: '1', user_day: '1',
      }],
    });

    const result = await checkAndIncrementChatRateLimit({
      tableName: 'distill_rate_limit_events',
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
    });

    expect(result.allowed).toBe(true);
    expect(mockQuery).toHaveBeenCalled();
  });

  it('still fails open when the database itself errors', async () => {
    // The availability trade is unchanged for genuine faults.
    mockQuery.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await checkAndIncrementChatRateLimit({
      tableName: 'distill_rate_limit_events',
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
    });

    expect(result.allowed).toBe(true);
    expect(mockLogError).toHaveBeenCalled();
  });
});
