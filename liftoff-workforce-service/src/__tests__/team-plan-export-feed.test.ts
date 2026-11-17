// The workspace export's two feeds over the Chief AI Officer's threads.
//
// Independently bounded, so a single long thread cannot carry an unbounded
// message array past the control plane's ceiling before it can count it; one
// ordered pass each, keyed on (created_at, id), so two rows sharing a boundary
// timestamp lose nothing; bounded by the caller's asOf in SQL. The route takes
// its tenant from the caller headers only, requires owner or admin, and
// refuses a tenantId in the query string.

const mockQuery = jest.fn();
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: async (_tenantId: string, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: mockQuery }),
}));

jest.mock('../workforce-plans/audit-log.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { exportMessages, exportThreads, EXPORT_FEED_MAX_LIMIT } from '../workforce-plans/chat-repository.js';
import { registerChatRoutes } from '../workforce-plans/chat-router.js';

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const A = '11111111-1111-4111-8111-111111111111';
const B = '44444444-4444-4444-8444-444444444444';
const AS_OF = new Date('2026-09-18T21:04:11.318Z');

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('exportThreads', () => {
  it('reads live threads of the tenant up to asOf, oldest first, by (created_at, id)', async () => {
    await exportThreads(TENANT_ID, { asOf: AS_OF });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM team_plan_threads t');
    expect(sql).toContain('t.tenant_id = $1');
    expect(sql).toContain('t.deleted_at IS NULL');
    expect(sql).toContain('t.created_at <= $2::timestamptz');
    expect(sql).toContain('ORDER BY t.created_at ASC, t.id ASC');
    expect(params).toEqual([TENANT_ID, AS_OF, null, null, EXPORT_FEED_MAX_LIMIT + 1]);
  });

  it('pages two threads with tied created_at without losing the second', async () => {
    const tied = '2026-09-01 10:00:00.123456+00';
    const at = new Date('2026-09-01T10:00:00.123Z');
    mockQuery
      .mockResolvedValueOnce({ rows: [
        { id: A, account_id: ACCOUNT_ID, title: 'One', created_at: at, updated_at: at, sort_cursor: tied },
        { id: B, account_id: ACCOUNT_ID, title: 'Two', created_at: at, updated_at: at, sort_cursor: tied },
      ] })
      .mockResolvedValueOnce({ rows: [
        { id: B, account_id: ACCOUNT_ID, title: 'Two', created_at: at, updated_at: at, sort_cursor: tied },
      ] });
    const page1 = await exportThreads(TENANT_ID, { asOf: AS_OF, limit: 1 });
    expect(page1.threads.map((t) => t.id)).toEqual([A]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await exportThreads(TENANT_ID, { asOf: AS_OF, limit: 1, cursor: page1.nextCursor });
    expect(page2.threads.map((t) => t.id)).toEqual([B]);
    expect(page2.nextCursor).toBeNull();
    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('(t.created_at, t.id) > ($3::timestamptz, $4::uuid)');
    // The boundary keeps its microseconds: Postgres text, not a JS Date.
    expect(params[2]).toBe(tied);
    expect(params[3]).toBe(A);
  });
});

describe('exportMessages', () => {
  it('joins through the thread for tenancy and reads the sender column', async () => {
    await exportMessages(TENANT_ID, { asOf: AS_OF, limit: 5000 });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM team_plan_messages m');
    expect(sql).toContain('JOIN team_plan_threads t ON t.id = m.thread_id');
    expect(sql).toContain('t.tenant_id = $1');
    expect(sql).toContain('t.deleted_at IS NULL');
    expect(sql).toContain('m.sender_account_id');
    expect(sql).toContain('m.contributors');
    expect(sql).toContain('m.created_at <= $2::timestamptz');
    expect(sql).toContain('ORDER BY m.created_at ASC, m.id ASC');
    expect(params[4]).toBe(EXPORT_FEED_MAX_LIMIT + 1);
  });

  it('maps a row, with a NULL sender staying null and a missing contributors column reading as nobody', async () => {
    const at = new Date('2026-09-01T10:00:00Z');
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: A, thread_id: B, role: 'user', content: 'hi', sender_account_id: null,
      attachments: null, media: null, message_type: null, created_at: at, sort_cursor: 'x',
    }] });
    const { messages } = await exportMessages(TENANT_ID, { asOf: AS_OF });
    expect(messages[0]).toEqual({
      id: A, threadId: B, role: 'user', content: 'hi', senderAccountId: null,
      attachments: [], media: null, contributors: [], messageType: null, createdAt: '2026-09-01T10:00:00.000Z',
    });
  });

  it('serves the contributors a reply carries', async () => {
    const contributors = [{ id: 'insights', label: 'Insights Manager' }];
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: A, thread_id: B, role: 'assistant', content: 'Costs are up 4%.', sender_account_id: null,
      attachments: null, media: null, contributors, message_type: null,
      created_at: new Date('2026-09-01T10:00:00Z'), sort_cursor: 'x',
    }] });
    const { messages } = await exportMessages(TENANT_ID, { asOf: AS_OF });
    expect(messages[0].contributors).toEqual(contributors);
  });
});

describe('GET /team-plan/export', () => {
  async function build(): Promise<FastifyInstance> {
    const app = Fastify();
    await registerChatRoutes(app);
    await app.ready();
    return app;
  }
  const headers = (role: string) => ({
    'x-tenant-id': TENANT_ID, 'x-account-id': ACCOUNT_ID, 'x-tenant-role': role,
  });

  it('serves threads and messages to an owner, tenant from the headers', async () => {
    const app = await build();
    const threads = await app.inject({ method: 'GET', url: '/team-plan/export', headers: headers('owner'),
      query: { kind: 'threads', asOf: AS_OF.toISOString(), limit: '50' } });
    expect(threads.statusCode).toBe(200);
    expect(threads.json()).toEqual({ threads: [], nextCursor: null });
    expect((mockQuery.mock.calls[0][1] as unknown[])[0]).toBe(TENANT_ID);
    expect((mockQuery.mock.calls[0][1] as unknown[])[4]).toBe(51);

    const messages = await app.inject({ method: 'GET', url: '/team-plan/export', headers: headers('admin'),
      query: { kind: 'messages', asOf: AS_OF.toISOString() } });
    expect(messages.statusCode).toBe(200);
    expect(messages.json()).toEqual({ messages: [], nextCursor: null });
    await app.close();
  });

  it('refuses a member and a viewer', async () => {
    const app = await build();
    for (const role of ['member', 'viewer']) {
      const res = await app.inject({ method: 'GET', url: '/team-plan/export', headers: headers(role),
        query: { kind: 'threads', asOf: AS_OF.toISOString() } });
      expect(res.statusCode).toBe(403);
    }
    expect(mockQuery).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a tenantId in the query string, a bad kind, a missing asOf and an oversize limit', async () => {
    const app = await build();
    const cases: Array<Record<string, string>> = [
      { kind: 'threads', asOf: AS_OF.toISOString(), tenantId: TENANT_ID },
      { kind: 'escalations', asOf: AS_OF.toISOString() },
      { kind: 'threads' },
      { kind: 'messages', asOf: AS_OF.toISOString(), limit: '201' },
    ];
    for (const query of cases) {
      const res = await app.inject({ method: 'GET', url: '/team-plan/export', headers: headers('owner'), query });
      expect(res.statusCode).toBe(400);
    }
    expect(mockQuery).not.toHaveBeenCalled();
    await app.close();
  });

  it('401s without the caller headers', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/team-plan/export',
      query: { kind: 'threads', asOf: AS_OF.toISOString() } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
