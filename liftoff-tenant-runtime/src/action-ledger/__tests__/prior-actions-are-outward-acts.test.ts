// A read is not an act.
//
// The ledger records every tool call against the thing it named, reads
// included, and a read carries the revision it saw. An agent reads the pull
// request to learn its head and THEN asks `have_i_acted_on` at that head — so
// a lookup that counted reads answered "acted" at the exact revision on every
// fresh head, and the agent declined the first review it had not written.
//
// `prior-work.ts` and `acts-this-run.ts` already restrict the same table to
// outward writes; this pins the third reader to the same rule.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => mockQuery(...a) },
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ActionRepository } from '../repository';

const ask = (scope: 'agent' | 'tenant') =>
  new ActionRepository().findPriorActionsOnTarget({
    tenantId: 't1',
    agentId: 'a1',
    targetRef: 'github:acme/api#122',
    scope,
    windowDays: 365,
    limit: 20,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('findPriorActionsOnTarget — outward acts only', () => {
  it.each(['agent', 'tenant'] as const)('filters to is_external_write rows (scope %s)', async (scope) => {
    await ask(scope);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/AND is_external_write = true/);
    expect(sql).toMatch(/status IN \('completed', 'succeeded'\)/);
  });

  it('keeps the versions on the rows for the service to grade', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ action_type: 'pull_request_review_write', connector: 'github-dd4c4689', target_version: 'f345c76', agent_id: 'a1', created_at: new Date('2026-09-16T20:55:05Z') }],
      rowCount: 1,
    });
    const rows = await ask('agent');
    expect(rows).toEqual([expect.objectContaining({ actionType: 'pull_request_review_write', targetVersion: 'f345c76' })]);
  });
});
