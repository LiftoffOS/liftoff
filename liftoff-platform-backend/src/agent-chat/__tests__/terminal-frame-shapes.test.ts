// POST /api/agent-chat/:agentId/chat-stream — the terminal frame, on the wire.
//
// `done` is the only thing that distinguishes a finished stream from a socket
// that died mid-turn: the client (Liftoff-React services/chatSse.ts) reports its
// absence at EOF as STREAM_TRUNCATED and tells the person the connection dropped.
//
// This router never lost the frame, and that is the reason to assert it. Liftoff
// and Insights ended their `interrupt_delivered` acknowledgment above the `try`
// whose `finally` wrote it; this router's `interrupt_delivered` is a domain event
// that flows through the same `finally` as everything else. That was luck —
// nothing held it there — so the routers now hold a ChatStream
// (src/common/chat-stream.ts) and these are the bytes that proves it, for the
// shapes greeting-stream-route.test.ts does not drive: a real turn, and a turn
// whose iterator threw.

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const mockGetByFirebaseUid = jest.fn();
const mockGetMembership = jest.fn();
const mockCheckChatAdmission = jest.fn();
const mockRunMultiAgentChatTurn = jest.fn();

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: mockGetByFirebaseUid,
  })),
}));
jest.mock('../../tenant-members', () => ({
  tenantMembersService: { getMembership: mockGetMembership },
}));
jest.mock('../admission', () => ({
  checkChatAdmission: (...args: unknown[]) => mockCheckChatAdmission(...args),
}));
jest.mock('../chat-repository', () => ({
  appendMessage: jest.fn(),
  getParticipants: jest.fn().mockResolvedValue([]),
}));
jest.mock('../multi-agent-service', () => ({
  runMultiAgentChatTurn: (...args: unknown[]) => mockRunMultiAgentChatTurn(...args),
  extractMentionedAgentIds: jest.fn().mockReturnValue([]),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { agentChatStreamRouter } from '../stream-router';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '33333333-3333-3333-3333-333333333333';
const DONE = 'event: done\ndata: {}\n\n';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { ctx?: { userId?: string } }).ctx = { userId: 'uid-1' };
    next();
  });
  app.use('/api/agent-chat', agentChatStreamRouter);
  return app;
}

const turn = () => request(makeApp())
  .post(`/api/agent-chat/${AGENT_ID}/chat-stream`)
  .send({ tenantId: TENANT_ID, threadId: THREAD_ID, content: 'hello' });

const doneFrames = (body: string): number => body.split(DONE).length - 1;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetByFirebaseUid.mockResolvedValue({ id: 'acc-1', firstName: 'Ada', lastName: 'L' });
  mockGetMembership.mockResolvedValue({ role: 'member' });
  mockCheckChatAdmission.mockResolvedValue({ allowed: true });
});

describe('every shape of an agent chat stream ends with exactly one done frame', () => {
  it('a normal turn', async () => {
    mockRunMultiAgentChatTurn.mockReturnValue((async function* () {
      yield { type: 'thinking' };
      yield { type: 'text_delta', text: 'on it' };
      yield { type: 'complete', message: { id: 'm1' } };
    })());

    const res = await turn();

    expect(res.status).toBe(200);
    expect(doneFrames(res.text)).toBe(1);
    expect(res.text.endsWith(DONE)).toBe(true);
  });

  it('an acknowledgment-only turn, where nothing else is terminal', async () => {
    // A mid-run message is answered with `interrupt_delivered` and no reply: the
    // reply belongs to the turn already running. That frame is deliberately NOT in
    // the client's terminal set — only the server can say the stream is over — so
    // `done` is the whole ending, and this is the shape the other two surfaces
    // broke.
    mockRunMultiAgentChatTurn.mockReturnValue((async function* () {
      yield { type: 'interrupt_delivered' };
    })());

    const res = await turn();

    expect(res.text).toBe('event: interrupt_delivered\ndata: {}\n\n' + DONE);
  });

  it('a turn whose iterator threw', async () => {
    mockRunMultiAgentChatTurn.mockReturnValue((async function* () {
      yield { type: 'thinking' };
      throw new Error('provider exploded');
    })());

    const res = await turn();

    expect(res.text).toContain('"code":"INTERNAL"');
    expect(doneFrames(res.text)).toBe(1);
    expect(res.text.endsWith(DONE)).toBe(true);
  });

  it('a turn that produced nothing at all', async () => {
    // An empty iterator is still a stream somebody is waiting on. Without the
    // frame the body would be zero bytes, which is exactly what a dropped socket
    // looks like.
    mockRunMultiAgentChatTurn.mockReturnValue((async function* () {})());

    const res = await turn();

    expect(res.text).toBe(DONE);
  });
});
