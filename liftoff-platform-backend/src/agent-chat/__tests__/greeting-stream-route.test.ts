// POST /api/agent-chat/:agentId/chat-stream — greeting mode.
//
// A chat page opens by asking for the greeting with no thread. Nothing is
// persisted for it, so a visit nobody typed into leaves no row behind and Chat
// History stays a list of conversations. The same request WITH a thread still
// persists, because a caller that already has a transcript expects the message
// back to append to it.

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const mockGetByFirebaseUid = jest.fn();
const mockGetMembership = jest.fn();
const mockCheckChatAdmission = jest.fn();
const mockAppendMessage = jest.fn();
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
  appendMessage: (...args: unknown[]) => mockAppendMessage(...args),
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

/** Parse an SSE body into ordered { event, data } frames, ignoring heartbeats. */
function parseSse(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split('\n\n')
    .filter(block => block.startsWith('event:'))
    .map(block => {
      const [eventLine, dataLine] = block.split('\n');
      return {
        event: eventLine.replace('event: ', ''),
        data: JSON.parse(dataLine.replace('data: ', '')),
      };
    });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetByFirebaseUid.mockResolvedValue({
    id: 'acc-1',
    firstName: 'Ada',
    lastName: 'L',
    // 13:00 UTC is 08:00 here, so the greeting is the morning one.
    timezone: 'America/New_York',
  });
  mockGetMembership.mockResolvedValue({ role: 'member' });
  mockCheckChatAdmission.mockResolvedValue({ allowed: true });
  jest.useFakeTimers({ now: new Date('2024-01-15T13:00:00Z'), advanceTimers: true });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('greeting mode without a thread', () => {
  it('says the greeting and writes nothing down', async () => {
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/chat-stream`)
      .send({ tenantId: TENANT_ID });

    expect(res.status).toBe(200);
    const frames = parseSse(res.text);
    expect(frames).toEqual([
      { event: 'text_delta', data: { text: 'How can I help you this morning?' } },
      { event: 'complete', data: { message: null } },
      { event: 'done', data: {} },
    ]);
    // The whole point: no thread, so no row.
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('never runs an agent turn', async () => {
    await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/chat-stream`)
      .send({ tenantId: TENANT_ID });

    expect(mockRunMultiAgentChatTurn).not.toHaveBeenCalled();
  });

  it('still enforces admission before saying anything', async () => {
    mockCheckChatAdmission.mockResolvedValue({
      allowed: false,
      httpStatus: 404,
      error: 'agent not found',
    });

    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/chat-stream`)
      .send({ tenantId: TENANT_ID });

    expect(res.status).toBe(404);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });
});

describe('greeting mode with a thread', () => {
  it('still persists, so callers holding a transcript are unaffected', async () => {
    const persisted = { id: 'msg-1', role: 'assistant', content: 'How can I help you this morning?' };
    mockAppendMessage.mockResolvedValue(persisted);

    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/chat-stream`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID });

    expect(res.status).toBe(200);
    expect(mockAppendMessage).toHaveBeenCalledWith(
      TENANT_ID,
      THREAD_ID,
      'assistant',
      'How can I help you this morning?',
      AGENT_ID,
    );
    expect(parseSse(res.text)).toContainEqual({
      event: 'complete',
      data: { message: persisted },
    });
  });
});

describe('validation', () => {
  it('refuses content with no thread to write it to', async () => {
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/chat-stream`)
      .send({ tenantId: TENANT_ID, content: 'hello' });

    expect(res.status).toBe(400);
    expect(mockRunMultiAgentChatTurn).not.toHaveBeenCalled();
  });
});
