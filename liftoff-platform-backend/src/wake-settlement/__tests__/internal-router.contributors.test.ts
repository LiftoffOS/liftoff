/**
 * Wake-settlement delivery attributes the reply it posts.
 *
 * A self-woken run, a continuation that outgrew its turn and an answer to a
 * stranded message all reach the thread through this route, and each may
 * have handed work to a teammate on the way. The runtime says who, the same
 * resolver every other writer of a team's speech uses names them, and the
 * row carries them — so a reply that landed with nobody watching shows the
 * same chips a streamed one does.
 */

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(
    async (_tenantId: string, fn: (client: { query: typeof mockQuery }) => unknown) => fn({ query: mockQuery }),
  ),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../agent-chat/run-artifacts', () => ({
  collectRunArtifacts: jest.fn().mockResolvedValue([]),
  withArtifacts: (text: string) => text,
  fileOutputAttachments: () => [],
}));
jest.mock('../../agent-chat/chat-repository', () => ({
  touchThreadOnClient: jest.fn(),
}));
const mockResolveContributors = jest.fn(async (_tenantId: string, ids: string[]) =>
  ids.map((id) => ({ id: `internal-${id}`, label: `Team ${id}` })),
);
jest.mock('../../agent-chat/contributors', () => ({
  resolveContributors: (...a: unknown[]) => mockResolveContributors(...(a as [string, string[]])),
}));

import express from 'express';
import request from 'supertest';
import { wakeSettlementInternalRouter } from '../internal-router';

const TOKEN = 'platform-callback-secret';
const TENANT = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const AGENT = '33333333-3333-3333-3333-333333333333';

let app: express.Express;
beforeAll(() => {
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  app = express();
  app.use(express.json());
  app.use('/api/internal/wake-settlement', wakeSettlementInternalRouter);
});

beforeEach(() => {
  mockQuery.mockReset();
  mockResolveContributors.mockClear();
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('INSERT INTO wake_settlement_ledger')) return { rows: [{ wake_id: 'w-1' }] };
    if (sql.includes('FROM agent_chat_threads')) {
      return { rows: [{ channel: 'web', external_thread_ref: null, slack_channel_id: null, agent_id: AGENT }] };
    }
    return { rows: [], rowCount: 1 };
  });
});

const insert = () => mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO agent_chat_messages'));

describe('wake settlement attributes the delivered reply', () => {
  it('writes the teammates the run brought in as the row\'s contributors', async () => {
    const res = await request(app)
      .post('/api/internal/wake-settlement')
      .set('x-service-auth', TOKEN)
      .send({ tenantId: TENANT, wakeId: 'w-1', threadId: THREAD, replyText: 'Checked with Security Review.', delegatedTo: ['rt-7'] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ delivered: true });
    expect(mockResolveContributors).toHaveBeenCalledWith(TENANT, ['rt-7']);
    expect(String(insert()![0])).toMatch(/role, content, contributors\)/);
    expect(insert()![1]).toEqual([
      TENANT, THREAD, AGENT, 'Checked with Security Review.',
      JSON.stringify([{ id: 'internal-rt-7', label: 'Team rt-7' }]),
    ]);
  });

  it('writes the empty list, never NULL, for a run that handed nothing over or an older runtime', async () => {
    const res = await request(app)
      .post('/api/internal/wake-settlement')
      .set('x-service-auth', TOKEN)
      .send({ tenantId: TENANT, wakeId: 'w-1', threadId: THREAD, replyText: 'Nothing new.' });

    expect(res.status).toBe(200);
    expect(mockResolveContributors).toHaveBeenCalledWith(TENANT, []);
    expect(insert()![1][4]).toBe('[]');
  });

  it('refuses a delegatedTo that is not a list of ids', async () => {
    const res = await request(app)
      .post('/api/internal/wake-settlement')
      .set('x-service-auth', TOKEN)
      .send({ tenantId: TENANT, wakeId: 'w-1', threadId: THREAD, replyText: 'x', delegatedTo: 'rt-7' });

    expect(res.status).toBe(400);
    expect(insert()).toBeUndefined();
  });
});
