// The picker's typeahead and the routing candidates read one roster
// statement (repository.ts readRoster), so the teams a person can pick from
// and the teams a message can be routed to can never disagree. Pinned here:
// the same statement text with its two switches, the picker's order, and
// the shapes each reader builds from the rows.

import { jest } from '@jest/globals';

const queryMock = jest.fn<(sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>>();
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: queryMock }),
  withTenantScope: async (_tenantId: string, fn: (c: { query: typeof queryMock }) => unknown) => fn({ query: queryMock }),
  withAdminScope: async (fn: (c: { query: typeof queryMock }) => unknown) => fn({ query: queryMock }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { listRouteCandidates, searchAgents } from '../repository';
import { ASSISTANT_TARGETS } from '../../assistant-targets';

const TENANT = '11111111-1111-1111-1111-111111111111';
const rows = [
  { id: 'a-1', role: 'Code Reviewer', messaging_nickname: null, summary: ' Reviews pull requests ', responsibilities: 'long text' },
  { id: 'a-2', role: 'Sales Ops Analyst', messaging_nickname: 'Sales Ops', summary: null, responsibilities: ' Reconciles the pipeline ' },
  { id: 'a-3', role: 'Release Manager', messaging_nickname: null, summary: null, responsibilities: null },
];

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows });
});

const sqlOf = (call: number): string => queryMock.mock.calls[call][0].replace(/\s+/g, ' ').trim();

describe('one roster statement', () => {
  it('the picker and the routing candidates run the same statement, switched by its parameters', async () => {
    await searchAgents(TENANT, ' rev ', 15);
    await listRouteCandidates(TENANT, 254);

    expect(sqlOf(0)).toBe(sqlOf(1));
    expect(sqlOf(0)).toContain("deleted_at IS NULL AND status <> 'draft'");
    expect(sqlOf(0)).toContain("(NOT $2::boolean OR status = 'active')");
    expect(sqlOf(0)).toContain('ORDER BY COALESCE(messaging_nickname, role) ASC');
    // The typeahead: every non-draft team whose name or role matches, at its limit.
    expect(queryMock.mock.calls[0][1]).toEqual([TENANT, false, 'rev', 15]);
    // Routing: active teams only, no name filter, one over the cap so the
    // caller can tell "over the cap" from "at the cap".
    expect(queryMock.mock.calls[1][1]).toEqual([TENANT, true, '', 255]);
  });

  it('searchAgents lists the assistants first, then the teams by nickname or role', async () => {
    const agents = await searchAgents(TENANT, undefined);

    expect(agents.slice(0, ASSISTANT_TARGETS.length)).toEqual(ASSISTANT_TARGETS.map((a) => ({ agentId: a.id, label: a.name })));
    expect(agents.slice(ASSISTANT_TARGETS.length)).toEqual([
      { agentId: 'a-1', label: 'Code Reviewer' },
      { agentId: 'a-2', label: 'Sales Ops' },
      { agentId: 'a-3', label: 'Release Manager' },
    ]);
  });

  it('listRouteCandidates carries the role and the summary the list_colleagues roster shows', async () => {
    expect(await listRouteCandidates(TENANT, 254)).toEqual([
      { id: 'a-1', role: 'Code Reviewer', summary: 'Reviews pull requests' },
      { id: 'a-2', role: 'Sales Ops Analyst', summary: 'Reconciles the pipeline' },
      { id: 'a-3', role: 'Release Manager', summary: '' },
    ]);
  });
});
