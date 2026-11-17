// One phase of a design change: the Chief AI Officer's reply is posted into
// the team's chat under its own name and pushed where the thread lives; a yes
// or a no is recorded once the Chief AI Officer has acted; a turn that fails
// says so plainly on the last retry and releases the proposal.

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
const mockAppend = jest.fn();
const mockGetThread = jest.fn();
jest.mock('../chat-repository', () => ({
  appendMessage: (...a: unknown[]) => mockAppend(...a),
  getThread: (...a: unknown[]) => mockGetThread(...a),
}));
const mockPush = jest.fn();
jest.mock('../out-of-turn-delivery', () => ({ pushOutOfTurnMessage: (...a: unknown[]) => mockPush(...a) }));
const mockGetById = jest.fn();
jest.mock('../../internal-agents/service', () => ({ internalAgentService: { getById: (...a: unknown[]) => mockGetById(...a) } }));
const mockMembership = jest.fn();
jest.mock('../../tenant-members/service', () => ({ tenantMembersService: { getMembership: (...a: unknown[]) => mockMembership(...a) } }));
const mockAccount = jest.fn();
jest.mock('../../accounts/service', () => ({ AccountService: jest.fn().mockImplementation(() => ({ getById: (...a: unknown[]) => mockAccount(...a) })) }));
const mockRunTurn = jest.fn();
const mockCreateThread = jest.fn();
jest.mock('../assistant-turn', () => ({
  runAssistantTurn: (...a: unknown[]) => mockRunTurn(...a),
  createAssistantThread: (...a: unknown[]) => mockCreateThread(...a),
  AssistantUnreachableError: class AssistantUnreachableError extends Error {},
}));
const mockGetPaired = jest.fn();
const mockPair = jest.fn();
jest.mock('../colleague-request', () => ({
  getPairedColleagueThread: (...a: unknown[]) => mockGetPaired(...a),
  pairColleagueThread: (...a: unknown[]) => mockPair(...a),
}));
const mockOwner = jest.fn();
jest.mock('../../cost-attribution/repository', () => ({ resolveAccountIdForTenant: (...a: unknown[]) => mockOwner(...a) }));
const mockMarkDecided = jest.fn();
const mockRelease = jest.fn();
jest.mock('../suggestion-service', () => ({
  markDecided: (...a: unknown[]) => mockMarkDecided(...a),
  releaseClaim: (...a: unknown[]) => mockRelease(...a),
}));
jest.mock('../../workspace-actions/teams', () => ({ teamDisplayName: (t: { role: string }) => t.role }));

import { answerInline, colleagueWorkerRouter } from '../colleague-worker';

const SECRET = 'worker-secret-under-test';
const TENANT = '22222222-2222-2222-2222-222222222222';
const AGENT = '55555555-5555-5555-5555-555555555555';
const SUGGESTION = '66666666-6666-6666-6666-666666666666';
const THREAD = '77777777-7777-7777-7777-777777777777';
const TASK = { tenantId: TENANT, agentId: AGENT, threadId: THREAD, colleague: 'caio', phase: 'preview', request: 'Step 3 should filter by price first.', suggestionId: SUGGESTION };

function post(body: unknown, opts: { secret?: string; retryCount?: number } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/chat-turns', colleagueWorkerRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/chat-turns/colleague`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.secret ? { 'x-internal-secret': opts.secret } : {}),
          ...(opts.retryCount !== undefined ? { 'X-CloudTasks-TaskRetryCount': String(opts.retryCount) } : {}),
        },
        body: JSON.stringify(body),
      }).then(async (res) => { const b = await res.json().catch(() => ({})); server.close(); resolve({ status: res.status, body: b as Record<string, unknown> }); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INTERNAL_SERVICE_SECRET = SECRET;
  mockGetThread.mockResolvedValue({ id: THREAD, tenantId: TENANT, accountId: 'acct-1', channel: 'slack' });
  mockGetById.mockResolvedValue({ id: AGENT, role: 'Launch Check', status: 'active' });
  mockMembership.mockResolvedValue({ role: 'owner' });
  mockAccount.mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' });
  mockGetPaired.mockResolvedValue(null);
  mockCreateThread.mockResolvedValue('caio-thread-1');
  mockPair.mockResolvedValue('caio-thread-1');
  mockOwner.mockResolvedValue('acct-owner');
  mockRunTurn.mockResolvedValue({ terminal: 'completed', replyContent: 'Here is what would change: … Apply it?', errorCode: null, answeredBy: null });
  mockAppend.mockResolvedValue({});
  mockPush.mockResolvedValue({ channel: 'slack', pushed: true });
  mockMarkDecided.mockResolvedValue(undefined);
  mockRelease.mockResolvedValue(undefined);
});

afterAll(() => { delete process.env.INTERNAL_SERVICE_SECRET; });

it('refuses without the worker identity', async () => {
  expect((await post(TASK)).status).toBe(401);
});

it('previews through the Chief AI Officer as the person, on a thread paired with the team chat, and posts the reply under its name', async () => {
  const res = await post(TASK, { secret: SECRET });
  expect(res.status).toBe(200);
  expect(mockCreateThread).toHaveBeenCalledWith('caio', { tenantId: TENANT, accountId: 'acct-1', role: 'owner' });
  expect(mockPair).toHaveBeenCalledWith(TENANT, THREAD, 'caio', 'caio-thread-1');
  const turn = mockRunTurn.mock.calls[0];
  expect(turn[0]).toBe('caio');
  expect(turn[1]).toMatchObject({ tenantId: TENANT, threadId: 'caio-thread-1', accountId: 'acct-1', displayName: 'Ada Lovelace', role: 'owner', origin: { via: 'slack' } });
  // The user row is the sentence a person may read on the Chief AI Officer's
  // paired thread: no team id, no tool, no instruction. Those ride in the
  // brief, which the model reads and nothing persists, framed with the team
  // as the forwarder; the thread's status row names the team too.
  expect(turn[1].userMessage).toBe(
    'Ada Lovelace asked the agent "Launch Check", in its own chat, for this change to the agent itself: "Step 3 should filter by price first.".',
  );
  expect(turn[1].userMessage).not.toContain(AGENT);
  expect(turn[1].userMessage).not.toContain('team_update');
  expect(turn[1].forwardedContext).toMatch(/^Background from Launch Check, which brought you into this conversation\. It is not shown to the person/);
  expect(turn[1].forwardedContext).toContain(`The agent's id is ${AGENT}.`);
  expect(turn[1].forwardedContext).toContain('Do not apply it.');
  // The team's conversation and its browser trail are readable: the sentence
  // that tells the Chief AI Officer where the person's own steps are.
  expect(turn[1].forwardedContext).toContain("The agent's conversation, with its browser trail, is readable with source_conversation__read.");
  expect(turn[1].forwardedBy).toEqual({ id: AGENT, label: 'Launch Check' });
  // The row is the colleague's words verbatim, attributed through
  // `contributors` — the chip every surface draws — and the push, which has
  // no chip to show, carries the speaker in the text and no team name over it.
  expect(mockAppend.mock.calls[0][3]).toBe('Here is what would change: … Apply it?');
  expect(mockAppend.mock.calls[0][8]).toBe('colleague');
  expect(mockAppend.mock.calls[0][14]).toEqual([{ id: 'caio', label: 'Chief AI Officer' }]);
  expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
    agentId: null, text: 'Chief AI Officer: Here is what would change: … Apply it?',
  }));
  expect(mockMarkDecided).not.toHaveBeenCalled();
});

it('reuses the paired thread, carries no origin for a dashboard thread, and records the decision on apply', async () => {
  mockGetPaired.mockResolvedValueOnce('caio-thread-9');
  mockGetThread.mockResolvedValueOnce({ id: THREAD, tenantId: TENANT, accountId: 'acct-1', channel: 'web' });
  mockRunTurn.mockResolvedValueOnce({ terminal: 'completed', replyContent: 'Launch Check is updated to version 4.', errorCode: null, answeredBy: null });
  const res = await post({ ...TASK, phase: 'apply', decision: 'accept', amendment: 'keep the old order' }, { secret: SECRET });
  expect(res.status).toBe(200);
  expect(mockCreateThread).not.toHaveBeenCalled();
  const turn = mockRunTurn.mock.calls[0][1];
  expect(turn.threadId).toBe('caio-thread-9');
  expect(turn.origin).toBeUndefined();
  expect(turn.userMessage).toBe('Yes, apply it, with this amendment: keep the old order.');
  expect(turn.forwardedContext).toContain('Call team_update with the confirmation handle from your preview; preview again first');
  expect(turn.forwardedBy).toEqual({ id: AGENT, label: 'Launch Check' });
  expect(mockMarkDecided).toHaveBeenCalledWith(TENANT, SUGGESTION, 'accepted');
});

it('records a no as dismissed after telling the Chief AI Officer', async () => {
  mockGetPaired.mockResolvedValueOnce('caio-thread-9');
  await post({ ...TASK, phase: 'apply', decision: 'decline' }, { secret: SECRET });
  expect(mockRunTurn.mock.calls[0][1].userMessage).toBe('No, leave the agent as it is; do not apply the change.');
  expect(mockRunTurn.mock.calls[0][1].forwardedContext).toContain('Reply in one sentence for that chat.');
  expect(mockMarkDecided).toHaveBeenCalledWith(TENANT, SUGGESTION, 'dismissed');
});

// The Insights Manager and Liftoff answer, in answer mode: no mutating
// action, no colleague of their own, no browser, and the reply lands in the
// team's chat under their own name.
it('answers a question through the colleague in answer mode and posts it under the colleague\'s name', async () => {
  mockGetPaired.mockResolvedValueOnce(null);
  mockCreateThread.mockResolvedValueOnce('insights-thread-1');
  mockPair.mockResolvedValueOnce('insights-thread-1');
  mockRunTurn.mockResolvedValueOnce({ terminal: 'completed', replyContent: '41 tasks ran today; 3 needed approval.', errorCode: null, answeredBy: null });
  const res = await post({ tenantId: TENANT, agentId: AGENT, threadId: THREAD, colleague: 'insights', phase: 'answer', request: 'How many tasks ran today?' }, { secret: SECRET });
  expect(res.status).toBe(200);
  expect(mockCreateThread).toHaveBeenCalledWith('insights', { tenantId: TENANT, accountId: 'acct-1', role: 'owner' });
  const turn = mockRunTurn.mock.calls[0];
  expect(turn[0]).toBe('insights');
  expect(turn[1]).toMatchObject({ threadId: 'insights-thread-1', toolMode: 'answer' });
  expect(turn[1].userMessage).toBe(
    'The agent "Launch Check" is working for Ada Lovelace and asked you this on their behalf: "How many tasks ran today?".',
  );
  expect(turn[1].forwardedContext).toContain('You cannot change anything from here');
  expect(turn[1].forwardedBy).toEqual({ id: AGENT, label: 'Launch Check' });
  expect(mockAppend.mock.calls[0][3]).toBe('41 tasks ran today; 3 needed approval.');
  expect(mockAppend.mock.calls[0][14]).toEqual([{ id: 'insights', label: 'Insights Manager' }]);
  expect(mockPush).toHaveBeenCalledWith(expect.objectContaining({
    agentId: null, text: 'Insights Manager: 41 tasks ran today; 3 needed approval.',
  }));
  expect(mockMarkDecided).not.toHaveBeenCalled();
});

// A team running unattended gets its answer back inline, as the workspace's
// own account, in answer mode.
it('answers inline for a team with no chat, as the workspace account', async () => {
  mockCreateThread.mockResolvedValueOnce('thread-1');
  mockAccount.mockResolvedValueOnce({ firstName: 'Work', lastName: 'Space', email: 'ws@example.com' });
  mockRunTurn.mockResolvedValueOnce({ terminal: 'completed', replyContent: 'Paris.', errorCode: null, answeredBy: null });
  const out = await answerInline({ tenantId: TENANT, agentId: AGENT, colleague: 'liftoff', request: 'Capital of France?' });
  expect(out).toEqual({ answered: true, reply: 'Paris.' });
  expect(mockMembership).toHaveBeenCalledWith(TENANT, 'acct-owner');
  expect(mockRunTurn.mock.calls[0][1]).toMatchObject({
    threadId: 'thread-1',
    accountId: 'acct-owner',
    toolMode: 'answer',
    userMessage: 'The agent "Launch Check" is working for Work Space and asked you this on their behalf: "Capital of France?".',
    forwardedBy: { id: AGENT, label: 'Launch Check' },
  });
  expect(mockRunTurn.mock.calls[0][1].forwardedContext).toMatch(/^Background from Launch Check/);
  expect(mockAppend).not.toHaveBeenCalled();
});

it('answers inline truthfully when the colleague cannot answer', async () => {
  mockRunTurn.mockResolvedValueOnce({ terminal: 'failed', replyContent: null, errorCode: 'busy', answeredBy: null });
  expect(await answerInline({ tenantId: TENANT, agentId: AGENT, colleague: 'insights', request: 'x' })).toEqual({ answered: false, reason: 'busy' });
});

it('retries a failed turn, and on the last retry says so plainly and releases the proposal', async () => {
  mockRunTurn.mockResolvedValue({ terminal: 'failed', replyContent: null, errorCode: 'busy', answeredBy: null });
  expect((await post(TASK, { secret: SECRET, retryCount: 0 })).status).toBe(500);
  expect(mockAppend).not.toHaveBeenCalled();
  const last = await post(TASK, { secret: SECRET, retryCount: 3 });
  expect(last.status).toBe(200);
  expect(mockAppend.mock.calls[0][3]).toMatch(/^I could not look at this change just now/);
  expect(mockAppend.mock.calls[0][14]).toEqual([{ id: 'caio', label: 'Chief AI Officer' }]);
  expect(mockMarkDecided).toHaveBeenCalledWith(TENANT, SUGGESTION, 'cooldown', 0);
});
