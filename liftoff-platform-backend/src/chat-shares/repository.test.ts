// Chat Shares Repository tests.
//
// The real repository runs against a mocked infrastructure/database whose
// stubs execute the passed function with a stub client — this is where the
// tenant-scoped upsert and the admin-scoped (pre-tenant-context) lookup are
// asserted; the router tests mock this repository entirely.

const mockClientQuery = jest.fn();
const stubClient = { query: mockClientQuery };
const mockWithTenantScope = jest.fn(
  async (_tenantId: string, fn: (c: typeof stubClient) => Promise<unknown>) => fn(stubClient),
);
const mockWithAdminScope = jest.fn(
  async (_ctx: unknown, fn: (c: typeof stubClient) => Promise<unknown>) => fn(stubClient),
);
jest.mock('../infrastructure/database', () => ({
  withTenantScope: (tenantId: string, fn: never) => mockWithTenantScope(tenantId, fn),
  withAdminScope: (ctx: unknown, fn: never) => mockWithAdminScope(ctx, fn),
}));

import { upsertShare, findShareById } from './repository';

const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '33333333-3333-3333-3333-333333333333';
const THREAD_ID = '44444444-4444-4444-4444-444444444444';
const ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';
const SHARE_ID = '66666666-6666-6666-6666-666666666666';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('upsertShare', () => {
  it('upserts under withTenantScope with the passed tenant id', async () => {
    mockClientQuery.mockResolvedValue({ rows: [{ id: SHARE_ID }] });

    const id = await upsertShare(TENANT_ID, AGENT_ID, THREAD_ID, ACCOUNT_ID);

    expect(id).toBe(SHARE_ID);
    expect(mockWithTenantScope).toHaveBeenCalledTimes(1);
    expect(mockWithTenantScope.mock.calls[0][0]).toBe(TENANT_ID);
    expect(mockWithAdminScope).not.toHaveBeenCalled();

    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockClientQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (tenant_id, thread_id)');
    expect(sql).toContain('RETURNING id');
    // Kind defaults to 'agent' so callers that predate team-plan sharing —
    // which is every existing one — keep writing agent-chat rows.
    expect(params).toEqual([TENANT_ID, AGENT_ID, THREAD_ID, ACCOUNT_ID, 'agent']);
  });

  it('writes the thread kind through when the caller passes one', async () => {
    mockClientQuery.mockResolvedValue({ rows: [{ id: SHARE_ID }] });

    await upsertShare(TENANT_ID, AGENT_ID, THREAD_ID, ACCOUNT_ID, 'team_plan');

    const [, params] = mockClientQuery.mock.calls[0];
    expect(params).toEqual([TENANT_ID, AGENT_ID, THREAD_ID, ACCOUNT_ID, 'team_plan']);
  });

  it.each(['insights', 'liftoff'] as const)(
    'writes a null agent id for a share of the %s surface',
    async (threadKind) => {
      // The pairing CHECK in migration 350 rejects an agent id on these kinds,
      // so a placeholder would fail the insert rather than merely lie.
      mockClientQuery.mockResolvedValue({ rows: [{ id: SHARE_ID }] });

      await upsertShare(TENANT_ID, null, THREAD_ID, ACCOUNT_ID, threadKind);

      const [, params] = mockClientQuery.mock.calls[0];
      expect(params).toEqual([TENANT_ID, null, THREAD_ID, ACCOUNT_ID, threadKind]);
    },
  );
});

describe('findShareById', () => {
  it('looks up by PK under withAdminScope with a caller + reason context', async () => {
    mockClientQuery.mockResolvedValue({
      rows: [{
        tenant_id: TENANT_ID,
        agent_id: AGENT_ID,
        thread_id: THREAD_ID,
        thread_kind: 'agent',
      }],
    });

    const share = await findShareById(SHARE_ID);

    expect(share).toEqual({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      threadKind: 'agent',
    });
    expect(mockWithTenantScope).not.toHaveBeenCalled();
    expect(mockWithAdminScope).toHaveBeenCalledTimes(1);

    const ctx = mockWithAdminScope.mock.calls[0][0] as { caller: string; reason: string };
    expect(ctx.caller).toBe('ChatSharesRepository.findShareById');
    expect(ctx.reason).toContain('pre-tenant-context');

    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockClientQuery.mock.calls[0];
    expect(sql.trim().startsWith('SELECT')).toBe(true);
    expect(params).toEqual([SHARE_ID]);
  });

  it('returns the team-plan kind for a CAIO share', async () => {
    mockClientQuery.mockResolvedValue({
      rows: [{
        tenant_id: TENANT_ID,
        agent_id: AGENT_ID,
        thread_id: THREAD_ID,
        thread_kind: 'team_plan',
      }],
    });

    const share = await findShareById(SHARE_ID);
    expect(share?.threadKind).toBe('team_plan');
  });

  it('reads a null thread_kind as agent chat', async () => {
    // Belt and braces for the window between the migration landing and the
    // column being backfilled by its DEFAULT: a row read as null must resolve
    // to the agent path, never to undefined, which the router would treat as
    // team_plan-not-agent and send to the wrong existence check.
    mockClientQuery.mockResolvedValue({
      rows: [{
        tenant_id: TENANT_ID,
        agent_id: AGENT_ID,
        thread_id: THREAD_ID,
        thread_kind: null,
      }],
    });

    const share = await findShareById(SHARE_ID);
    expect(share?.threadKind).toBe('agent');
  });

  it.each(['insights', 'liftoff'] as const)(
    'resolves a share of the %s surface without an agentId key at all',
    async (threadKind) => {
      // Neither surface has an agent, so the resolution carries no agent id: not
      // null, not a placeholder. The frontend narrows on threadKind and gets a
      // shape where the key does not exist.
      mockClientQuery.mockResolvedValue({
        rows: [{
          tenant_id: TENANT_ID,
          agent_id: null,
          thread_id: THREAD_ID,
          thread_kind: threadKind,
        }],
      });

      const share = await findShareById(SHARE_ID);

      expect(share).toEqual({
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        threadKind,
      });
      expect(share && 'agentId' in share).toBe(false);
    },
  );

  it('returns null on zero rows', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    const share = await findShareById(SHARE_ID);
    expect(share).toBeNull();
  });
});
