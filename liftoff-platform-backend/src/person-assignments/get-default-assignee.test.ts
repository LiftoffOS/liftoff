// getDefaultAssignee: earliest ACTIVE assignee for an internal agent. The query joins
// tenant_members (so a removed member is excluded) and orders by (created_at, id) so a tie
// resolves deterministically.

jest.mock('../infrastructure/database', () => {
  const query = jest.fn();
  return {
    withTenantScope: (_t: string, fn: (c: unknown) => unknown) => fn({ query }),
    __query: query,
  };
});
jest.mock('../human-feedback/human-task-counts', () => ({ getHumanTaskCounts: jest.fn() }));
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as db from '../infrastructure/database';
import { personAssignmentsService } from './service';

const mockQuery = (db as unknown as { __query: jest.Mock }).__query;

describe('getDefaultAssignee', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns the earliest active assignee account_id and enforces join + tie-break', async () => {
    mockQuery.mockResolvedValue({ rows: [{ account_id: 'acct-1' }] });
    const r = await personAssignmentsService.getDefaultAssignee('t', 'agent');
    expect(r).toBe('acct-1');

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/JOIN tenant_members/);                       // removed members excluded
    expect(sql).toMatch(/ORDER BY pa\.created_at ASC, pa\.id ASC/);   // deterministic tie-break by id
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/agent_origin = 'internal'/);
  });

  it('returns null when there is no active assignee', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await personAssignmentsService.getDefaultAssignee('t', 'agent');
    expect(r).toBeNull();
  });
});
