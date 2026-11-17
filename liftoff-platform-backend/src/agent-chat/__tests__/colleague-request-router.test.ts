// The runtime's propose_change tool lands on this route: the callback secret
// gates it, an inactive team or a foreign thread is refused before anything
// is written, and the registration outcome reaches the caller verbatim.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import express from 'express';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockGetById = jest.fn();
jest.mock('../../internal-agents/service', () => ({ internalAgentService: { getById: (...a: unknown[]) => mockGetById(...a) } }));
const mockGetThread = jest.fn();
const mockGetParticipants = jest.fn();
jest.mock('../chat-repository', () => ({
  getThread: (...a: unknown[]) => mockGetThread(...a),
  getParticipants: (...a: unknown[]) => mockGetParticipants(...a),
}));
const mockRegister = jest.fn();
const mockQuestion = jest.fn();
jest.mock('../colleague-request', () => ({
  registerDesignChange: (...a: unknown[]) => mockRegister(...a),
  registerColleagueQuestion: (...a: unknown[]) => mockQuestion(...a),
}));
const mockAnswerInline = jest.fn();
jest.mock('../colleague-worker', () => ({ answerInline: (...a: unknown[]) => mockAnswerInline(...a) }));

import { colleagueRequestRouter } from '../colleague-request-router';

const TOKEN = 'callback-token-under-test';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '55555555-5555-5555-5555-555555555555';
const THREAD_ID = '66666666-6666-6666-6666-666666666666';
const VALID_BODY = { tenantId: TENANT_ID, internalAgentId: AGENT_ID, threadId: THREAD_ID, colleague: 'caio', request: 'Step 3 should filter by price first.', area: 'workflow' };

function post(body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use('/api/internal/agent-chat', colleagueRequestRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/agent-chat/colleague-request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-service-auth': token } : {}) },
        body: JSON.stringify(body),
      }).then(async (res) => { const b = await res.json().catch(() => ({})); server.close(); resolve({ status: res.status, body: b as Record<string, unknown> }); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  mockGetById.mockResolvedValue({ id: AGENT_ID, status: 'active' });
  mockGetThread.mockResolvedValue({ id: THREAD_ID, tenantId: TENANT_ID });
  mockGetParticipants.mockResolvedValue([{ agentId: AGENT_ID }]);
  mockRegister.mockResolvedValue({ registered: true });
  mockQuestion.mockResolvedValue({ registered: true });
  mockAnswerInline.mockResolvedValue({ answered: true, reply: '41 runs today.' });
});

it('refuses without the callback secret', async () => {
  expect((await post(VALID_BODY)).status).toBe(401);
  expect((await post(VALID_BODY, 'wrong')).status).toBe(401);
  expect(mockRegister).not.toHaveBeenCalled();
});

it('registers and relays the outcome', async () => {
  const res = await post(VALID_BODY, TOKEN);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ registered: true });
  expect(mockRegister).toHaveBeenCalledWith({ tenantId: TENANT_ID, agentId: AGENT_ID, threadId: THREAD_ID, change: VALID_BODY.request, area: 'workflow' });
});

it('hands a question in a chat to the colleague for an answer into the chat', async () => {
  const res = await post({ ...VALID_BODY, colleague: 'insights', request: 'How many runs today?' }, TOKEN);
  expect(res.body).toEqual({ registered: true });
  expect(mockQuestion).toHaveBeenCalledWith({ tenantId: TENANT_ID, agentId: AGENT_ID, threadId: THREAD_ID, colleague: 'insights', request: 'How many runs today?' });
  expect(mockRegister).not.toHaveBeenCalled();
});

// Nobody is present in an unattended run: an answer comes back inline, and
// the Chief AI Officer cannot be asked, because nobody is there to say yes.
it('answers a question inline for a team with no chat, and refuses the Chief AI Officer there', async () => {
  const { threadId: _t, ...noThread } = VALID_BODY;
  const res = await post({ ...noThread, colleague: 'liftoff', request: 'What is the capital of France?' }, TOKEN);
  expect(res.body).toEqual({ answered: true, reply: '41 runs today.' });
  expect(mockAnswerInline).toHaveBeenCalledWith({ tenantId: TENANT_ID, agentId: AGENT_ID, colleague: 'liftoff', request: 'What is the capital of France?' });
  const caio = await post({ ...noThread, colleague: 'caio' }, TOKEN);
  expect(caio.body).toEqual({ registered: false, reason: 'needs_the_person' });
});

it('refuses an inactive team and a thread the team is not in, before writing anything', async () => {
  mockGetById.mockResolvedValueOnce({ id: AGENT_ID, status: 'paused' });
  expect((await post(VALID_BODY, TOKEN)).status).toBe(404);
  mockGetParticipants.mockResolvedValueOnce([{ agentId: 'someone-else' }]);
  expect((await post(VALID_BODY, TOKEN)).status).toBe(404);
  expect(mockRegister).not.toHaveBeenCalled();
});

it('relays a refusal verbatim so the team can say something true', async () => {
  mockRegister.mockResolvedValueOnce({ registered: false, reason: 'open_proposal_exists' });
  expect((await post(VALID_BODY, TOKEN)).body).toEqual({ registered: false, reason: 'open_proposal_exists' });
});
