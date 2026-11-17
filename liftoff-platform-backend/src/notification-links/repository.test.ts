// Notification Links Repository tests.
//
// Same shape as chat-shares/repository.test.ts, which this is modelled on: the
// real repository runs against a mocked infrastructure/database whose stubs
// execute the passed function with a stub client, so the tenant-scoped
// find-or-create and the admin-scoped (pre-tenant-context) lookup are both
// asserted here.

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

import { findOrCreateLink, findLinkById } from './repository';

const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '33333333-3333-3333-3333-333333333333';
const THREAD_ID = '44444444-4444-4444-4444-444444444444';
const LINK_ID = '66666666-6666-6666-6666-666666666666';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('findOrCreateLink', () => {
  it('writes under tenant scope, because the table is RLS', async () => {
    mockClientQuery.mockResolvedValue({ rows: [{ id: LINK_ID }] });
    await findOrCreateLink({
      tenantId: TENANT_ID,
      destination: 'chat',
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      recordId: null,
    });
    expect(mockWithTenantScope).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(mockWithAdminScope).not.toHaveBeenCalled();
  });

  // The arbiter must repeat notification_links_destination_key's expressions
  // verbatim or Postgres cannot infer the index, and the insert raises a unique
  // violation instead of reusing the link.
  it('conflicts on the index expressions so links are reused', async () => {
    mockClientQuery.mockResolvedValue({ rows: [{ id: LINK_ID }] });
    await findOrCreateLink({
      tenantId: TENANT_ID,
      destination: 'chat',
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      recordId: null,
    });
    const sql = mockClientQuery.mock.calls[0][0] as string;
    expect(sql).toContain(
      "ON CONFLICT (tenant_id, destination, surface, COALESCE(thread_id::text, ''), COALESCE(record_id, ''))",
    );
    expect(sql).toContain('RETURNING id');
  });

  it('returns the id on both the insert and the reuse path', async () => {
    mockClientQuery.mockResolvedValue({ rows: [{ id: LINK_ID }] });
    await expect(
      findOrCreateLink({
        tenantId: TENANT_ID,
        destination: 'review',
        agentId: null,
        threadId: null,
        recordId: 'esc-1',
      }),
    ).resolves.toBe(LINK_ID);
  });
});

describe('findLinkById', () => {
  it('looks up by primary key under admin scope, before any tenant is known', async () => {
    mockClientQuery.mockResolvedValue({
      rows: [{ tenantId: TENANT_ID, destination: 'review', agentId: null, threadId: null, recordId: 'esc-1' }],
    });
    await findLinkById(LINK_ID);
    expect(mockWithAdminScope).toHaveBeenCalledWith(
      expect.objectContaining({ caller: expect.stringContaining('findLinkById') }),
      expect.any(Function),
    );
  });

  it('narrows a chat link to the shape that carries a thread', async () => {
    mockClientQuery.mockResolvedValue({
      rows: [{ tenantId: TENANT_ID, destination: 'chat', surface: 'agent', agentId: AGENT_ID, threadId: THREAD_ID, recordId: null }],
    });
    expect(await findLinkById(LINK_ID)).toEqual({
      tenantId: TENANT_ID,
      destination: 'chat',
      surface: 'agent',
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      recordId: null,
    });
  });

  // Liftoff, Insights and the team plan have no internal_agents row at all, so
  // the resolved link must not carry an agent key the frontend would try to
  // navigate with. Each is its own page.
  it.each(['liftoff', 'insights', 'team_plan'] as const)(
    'narrows a %s link to a thread with no agent',
    async (surface) => {
      mockClientQuery.mockResolvedValue({
        rows: [{ tenantId: TENANT_ID, destination: 'chat', surface, agentId: null, threadId: THREAD_ID, recordId: null }],
      });
      expect(await findLinkById(LINK_ID)).toEqual({
        tenantId: TENANT_ID,
        destination: 'chat',
        surface,
        threadId: THREAD_ID,
        recordId: null,
      });
    },
  );

  // An agent-chat row with no agent cannot open a chat page: that surface needs
  // both ids. The platform surfaces above are the ones allowed to have none.
  it('treats an agent chat row with no agent as not found', async () => {
    mockClientQuery.mockResolvedValue({
      rows: [{ tenantId: TENANT_ID, destination: 'chat', surface: 'agent', agentId: null, threadId: THREAD_ID, recordId: null }],
    });
    expect(await findLinkById(LINK_ID)).toBeNull();
  });

  it('drops the agent and thread keys entirely for a review link', async () => {
    mockClientQuery.mockResolvedValue({
      rows: [{ tenantId: TENANT_ID, destination: 'review', agentId: null, threadId: null, recordId: 'esc-1' }],
    });
    expect(await findLinkById(LINK_ID)).toEqual({
      tenantId: TENANT_ID,
      destination: 'review',
      recordId: 'esc-1',
    });
  });

  // A chat row missing its thread cannot open anything. Returning it would hand
  // the frontend a destination it has to fail on later, further from the cause.
  it('treats a malformed chat row as not found', async () => {
    mockClientQuery.mockResolvedValue({
      rows: [{ tenantId: TENANT_ID, destination: 'chat', surface: 'agent', agentId: AGENT_ID, threadId: null, recordId: null }],
    });
    expect(await findLinkById(LINK_ID)).toBeNull();
  });

  it('returns null on zero rows', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    expect(await findLinkById(LINK_ID)).toBeNull();
  });
});
