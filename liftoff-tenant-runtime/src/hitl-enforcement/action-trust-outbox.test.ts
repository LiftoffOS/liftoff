// action-trust-outbox drainer: delivers a claimed row and marks it completed; on delivery
// failure it schedules a retry rather than completing.

// Two served tenants. The drain runs once per tenant, so a fixture with one
// tenant cannot tell a drain that covers them all apart from one that covers the
// first — and the rows of the tenants it skips are claimed by nothing else.
const SERVED = ['t', 't2'];

jest.mock('../infrastructure/database', () => {
  const query = jest.fn();
  const { servedTenantsPool } = require('../test-utils/served-tenants');
  return {
    // The drain runs inside withTenantScope per tenant so RLS permits its
    // claims; the mock invokes the callback with a client backed by the same query mock.
    withTenantScope: (_t: string, fn: (c: { query: typeof query }) => unknown) => fn({ query }),
    // The DATABASE is stubbed and the real tenant registry reads it; mocking the
    // registry would replace the fan-out under test with this file's assumption.
    getPool: () => servedTenantsPool(SERVED),
    __query: query,
  };
});
jest.mock('../governance/governance-service-client', () => ({
  postActionTrustDecisions: jest.fn(),
}));
jest.mock('../infrastructure/logging', () => {
  const sink = { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  // Both names: `log` and `logger` are the same root logger, and the tenant
  // fan-out this drain runs through imports it under the second one.
  return { log: sink, logger: sink };
});

import * as db from '../infrastructure/database';
import { runActionTrustOutboxOnce } from './action-trust-outbox';
import { postActionTrustDecisions } from '../governance/governance-service-client';

const mockQuery = (db as unknown as { __query: jest.Mock }).__query;
const mockPost = postActionTrustDecisions as jest.Mock;

const claimedRow = {
  id: 'o1',
  payload: { tenantId: 't', agentId: 'a', gateReason: 'sensitive_work', approvalId: 'ap', decisions: [] },
  attempts: 0,
  max_attempts: 10,
};

function sqlOf(callIndex: number): string {
  return String(mockQuery.mock.calls[callIndex]?.[0] ?? '');
}

describe('action-trust-outbox drainer', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockPost.mockReset();
  });

  it('delivers a claimed row and marks it completed', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })            // reaper
      .mockResolvedValueOnce({ rows: [claimedRow] })  // claim -> row
      .mockResolvedValueOnce({ rows: [] })            // markCompleted
      .mockResolvedValueOnce({ rows: [] });           // claim -> none (break)
    mockPost.mockResolvedValue(undefined);

    await runActionTrustOutboxOnce();

    expect(mockPost).toHaveBeenCalledTimes(1);
    const completed = mockQuery.mock.calls.some((_, i) => sqlOf(i).includes("status='completed'"));
    expect(completed).toBe(true);
  });

  it('on delivery failure schedules a retry and does not complete', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })            // reaper
      .mockResolvedValueOnce({ rows: [claimedRow] })  // claim -> row
      .mockResolvedValueOnce({ rows: [] })            // markRetry
      .mockResolvedValueOnce({ rows: [] });           // claim -> none (break)
    mockPost.mockRejectedValue(new Error('governance POST failed: 500'));

    await runActionTrustOutboxOnce();

    const retried = mockQuery.mock.calls.some(
      (_, i) => sqlOf(i).includes('next_attempt_at') && sqlOf(i).includes("status='pending'"),
    );
    expect(retried).toBe(true);
    const completed = mockQuery.mock.calls.some((_, i) => sqlOf(i).includes("status='completed'"));
    expect(completed).toBe(false);
  });
});
