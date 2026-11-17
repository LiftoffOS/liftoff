// Mark all team-plan threads read: POST /team-plan/threads/read-all.
//
// The bulk write must cover exactly the threads the caller's unread badge
// counts, so it carries getUnreadThreadCount's filters: a member marks only
// their own threads, an owner or admin every thread they can see, and only
// threads a person has spoken in. The account always comes from the trusted
// headers, never the body.

const mockQuery = jest.fn();
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: async (_tenantId: string, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: mockQuery }),
}));

jest.mock('../workforce-plans/audit-log.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { markAllThreadsRead } from '../workforce-plans/chat-repository.js';
import { registerChatRoutes } from '../workforce-plans/chat-router.js';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('markAllThreadsRead', () => {
  it("upserts the member's own unread threads, on the badge's filters", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });

    expect(await markAllThreadsRead(TENANT_ID, ACCOUNT_ID, 'member')).toBe(2);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO team_plan_thread_reads');
    expect(sql).toContain('ON CONFLICT (thread_id, account_id)');
    expect(sql).toContain('t.account_id = $2');
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM team_plan_messages/);
    expect(sql).toContain('t.last_assistant_message_at IS NOT NULL');
    expect(params).toEqual([TENANT_ID, ACCOUNT_ID]);
  });

  it('covers the whole workspace for owner and admin', async () => {
    await markAllThreadsRead(TENANT_ID, ACCOUNT_ID, 'owner');

    expect(mockQuery.mock.calls[0][0]).not.toContain('t.account_id = $2');
  });
});

describe('POST /team-plan/threads/read-all', () => {
  async function build(): Promise<FastifyInstance> {
    const app = Fastify();
    await registerChatRoutes(app);
    await app.ready();
    return app;
  }

  it('marks read for the header caller and answers 204', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/threads/read-all',
      headers: { 'x-tenant-id': TENANT_ID, 'x-account-id': ACCOUNT_ID, 'x-tenant-role': 'member' },
      payload: { accountId: 'someone-else' },
    });

    expect(res.statusCode).toBe(204);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][1]).toEqual([TENANT_ID, ACCOUNT_ID]);
    await app.close();
  });

  it('401s without the caller headers, before touching the database', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/team-plan/threads/read-all' });

    expect(res.statusCode).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
    await app.close();
  });
});
