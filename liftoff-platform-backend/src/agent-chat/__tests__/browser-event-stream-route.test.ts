// POST /api/agent-chat/:agentId/chat-stream — the person's browser events.
//
// A hand-back or a point arrives as an event naming the hold the runtime
// recorded, beside the words the person typed while driving or instead of
// them. The route verifies the claim against the runtime's record before it
// writes anything: a claim that fails is a 409 the client treats as quiet.
// What checks out is one status row, the person's, keyed on the hold so a
// replay adds nothing, and the turn runs with the event on it.

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  ListTakeoverActivityResponseSchema,
  TakeoverActionSchema,
  TakeoverAction_ValueDisposition,
  TakeoverHoldSchema,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';

const mockGetByFirebaseUid = jest.fn();
const mockGetMembership = jest.fn();
const mockCheckChatAdmission = jest.fn();
const mockAppendStatusRowOnce = jest.fn();
const mockRunMultiAgentChatTurn = jest.fn();
const mockListTakeoverActivity = jest.fn();

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
  appendStatusRowOnce: (...args: unknown[]) => mockAppendStatusRowOnce(...args),
  getParticipants: jest.fn().mockResolvedValue([]),
}));
jest.mock('../multi-agent-service', () => ({
  runMultiAgentChatTurn: (...args: unknown[]) => mockRunMultiAgentChatTurn(...args),
  extractMentionedAgentIds: jest.fn().mockReturnValue([]),
}));
jest.mock('../../connectors/tenant-runtime-service-client', () => ({
  getBrowserSessionsServiceClient: jest.fn(async () => ({
    listTakeoverActivity: (...args: unknown[]) => mockListTakeoverActivity(...args),
  })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import { agentChatStreamRouter } from '../stream-router';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '33333333-3333-3333-3333-333333333333';
const HOLD = '44444444-4444-4444-8444-444444444444';

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

const recent = () => new Date(Date.now() - 60_000);
const releasedHold = (over: Record<string, unknown> = {}) => create(TakeoverHoldSchema, {
  id: HOLD, kind: 'takeover', startedAt: timestampFromDate(new Date(Date.now() - 120_000)), endedAt: timestampFromDate(recent()), endReason: 'released', live: false,
  ...over,
});
const runtimeAnswers = (holds: unknown[]) => {
  mockListTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: holds as never, nextCursor: '' }));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetByFirebaseUid.mockResolvedValue({ id: 'acc-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' });
  mockGetMembership.mockResolvedValue({ role: 'member' });
  mockCheckChatAdmission.mockResolvedValue({ allowed: true });
  mockAppendStatusRowOnce.mockResolvedValue({ id: 'row-1' });
  mockRunMultiAgentChatTurn.mockImplementation(async function* () {
    yield { type: 'complete', message: { id: 'm-1', role: 'assistant', content: 'Picking up from the page you left.' } };
  });
  runtimeAnswers([releasedHold()]);
});

describe('a hand-back', () => {
  it('verifies the hold, writes the status row once under its key, and runs the turn with the event and no words', async () => {
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/chat-stream`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID, browserHandback: { holdId: HOLD } });
    expect(res.status).toBe(200);
    expect(mockListTakeoverActivity).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD_ID, holdId: HOLD, limit: 1 }));
    expect(mockAppendStatusRowOnce).toHaveBeenCalledWith(
      TENANT_ID, THREAD_ID, 'Ada Lovelace handed the browser back', 'browser_handback', `browser_handback:${HOLD}`,
    );
    expect(mockRunMultiAgentChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      content: '', browserEvent: { kind: 'handback', holdId: HOLD }, threadId: THREAD_ID,
    }));
    expect(res.text).toContain('event: complete');
  });

  it('rides beside the words the person sent while driving, in one turn', async () => {
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/chat-stream`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID, content: 'now summarise it', browserHandback: { holdId: HOLD } });
    expect(res.status).toBe(200);
    expect(mockRunMultiAgentChatTurn).toHaveBeenCalledTimes(1);
    expect(mockRunMultiAgentChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      content: 'now summarise it', browserEvent: { kind: 'handback', holdId: HOLD },
    }));
  });

  it("is 409 handback_not_pending, no row and no turn, when the hold is not this thread's, not released, or older than fifteen minutes", async () => {
    for (const holds of [
      [],
      [releasedHold({ endReason: 'session_closed' })],
      [releasedHold({ live: true, endedAt: undefined, endReason: '' })],
      [releasedHold({ endedAt: timestampFromDate(new Date(Date.now() - 16 * 60_000)) })],
    ]) {
      runtimeAnswers(holds);
      const res = await request(makeApp())
        .post(`/api/agent-chat/${AGENT_ID}/chat-stream`)
        .send({ tenantId: TENANT_ID, threadId: THREAD_ID, browserHandback: { holdId: HOLD } });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'handback_not_pending' });
    }
    expect(mockAppendStatusRowOnce).not.toHaveBeenCalled();
    expect(mockRunMultiAgentChatTurn).not.toHaveBeenCalled();
  });

  it('a replay of the same hand-back writes no second row and still runs a turn', async () => {
    mockAppendStatusRowOnce.mockResolvedValueOnce({ id: 'row-1' }).mockResolvedValueOnce(null);
    const app = makeApp();
    await request(app).post(`/api/agent-chat/${AGENT_ID}/chat-stream`).send({ tenantId: TENANT_ID, threadId: THREAD_ID, browserHandback: { holdId: HOLD } });
    await request(app).post(`/api/agent-chat/${AGENT_ID}/chat-stream`).send({ tenantId: TENANT_ID, threadId: THREAD_ID, browserHandback: { holdId: HOLD } });
    expect(mockAppendStatusRowOnce).toHaveBeenCalledTimes(2);
    expect(mockAppendStatusRowOnce.mock.calls[1][4]).toBe(`browser_handback:${HOLD}`);
    expect(mockRunMultiAgentChatTurn).toHaveBeenCalledTimes(2);
  });
});

describe('a point', () => {
});

describe('the body', () => {
  it('refuses an event without a thread', async () => {
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/chat-stream`)
      .send({ tenantId: TENANT_ID, browserHandback: { holdId: HOLD } });
    expect(res.status).toBe(400);
    expect(mockRunMultiAgentChatTurn).not.toHaveBeenCalled();
  });
});
