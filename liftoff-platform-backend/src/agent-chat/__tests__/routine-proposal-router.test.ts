// The runtime's propose_routine tool lands on this route.
//
// What matters: the callback secret gates it; an inactive or wrong-space team
// id and a foreign thread are refused before anything is written; and the
// registration outcome — including the budget and latch refusals — reaches the
// caller verbatim, because the model's next sentence is built from it.

import express from 'express';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetById = jest.fn();
jest.mock('../../internal-agents/service', () => ({
  internalAgentService: { getById: (...a: unknown[]) => mockGetById(...a) },
}));

const mockGetThread = jest.fn();
const mockGetParticipants = jest.fn();
jest.mock('../chat-repository', () => ({
  getThread: (...a: unknown[]) => mockGetThread(...a),
  getParticipants: (...a: unknown[]) => mockGetParticipants(...a),
}));

const mockRegisterRoutineProposal = jest.fn();
jest.mock('../suggestion-flow', () => ({
  registerRoutineProposal: (...a: unknown[]) => mockRegisterRoutineProposal(...a),
}));

import { routineProposalRouter } from '../routine-proposal-router';

const TOKEN = 'callback-token-under-test';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '55555555-5555-5555-5555-555555555555';
const THREAD_ID = '66666666-6666-6666-6666-666666666666';

const VALID_BODY = {
  tenantId: TENANT_ID,
  internalAgentId: AGENT_ID,
  threadId: THREAD_ID,
  routineProse: 'Every Monday at 9am, compile the overdue invoices and post the list in the thread.',
};

function buildApp() {
  const app = express();
  app.use('/api/internal/agent-chat', routineProposalRouter);
  return app;
}

function post(
  app: express.Express,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/agent-chat/routine-proposal`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-service-auth': token } : {}),
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  mockGetById.mockResolvedValue({ id: AGENT_ID, status: 'active' });
  mockGetThread.mockResolvedValue({ id: THREAD_ID, tenantId: TENANT_ID });
  mockGetParticipants.mockResolvedValue([
    { agentId: AGENT_ID, addedBy: 'acc-1', role: 'lead', addedAt: '2026-09-01T00:00:00.000Z' },
  ]);
  mockRegisterRoutineProposal.mockResolvedValue({ registered: true });
});

afterAll(() => {
  delete process.env.PLATFORM_CALLBACK_TOKEN;
});

describe('auth', () => {
  it('rejects a missing token', async () => {
    const res = await post(buildApp(), VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockRegisterRoutineProposal).not.toHaveBeenCalled();
  });

  it('rejects when the token is not configured at all', async () => {
    delete process.env.PLATFORM_CALLBACK_TOKEN;
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(401);
  });
});

describe('validation', () => {
  it('rejects a malformed body', async () => {
    const res = await post(buildApp(), { ...VALID_BODY, routineProse: '' }, TOKEN);
    expect(res.status).toBe(400);
  });

  it('404s an id that matches no active team member', async () => {
    // A wrong-space id (runtime agents.id) matches zero rows with no error —
    // this is also the branch that catches it.
    mockGetById.mockResolvedValue(null);
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(404);
    expect(mockRegisterRoutineProposal).not.toHaveBeenCalled();
  });

  it('404s a paused team member', async () => {
    mockGetById.mockResolvedValue({ id: AGENT_ID, status: 'paused' });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(404);
  });

  it('404s a thread outside the tenant', async () => {
    mockGetThread.mockResolvedValue(null);
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(404);
    expect(mockGetThread).toHaveBeenCalledWith(THREAD_ID, TENANT_ID);
    expect(mockRegisterRoutineProposal).not.toHaveBeenCalled();
  });

  it('404s a thread this team member is not a participant of, with the SAME body', async () => {
    const missingThread = await (async () => {
      mockGetThread.mockResolvedValueOnce(null);
      return post(buildApp(), VALID_BODY, TOKEN);
    })();

    mockGetParticipants.mockResolvedValue([
      { agentId: '77777777-7777-7777-7777-777777777777', addedBy: 'acc-1', role: 'lead', addedAt: '2026-09-01T00:00:00.000Z' },
    ]);
    const wrongAgent = await post(buildApp(), VALID_BODY, TOKEN);

    expect(wrongAgent.status).toBe(404);
    // A wrong pairing must read exactly like an unknown thread.
    expect(wrongAgent.body).toEqual(missingThread.body);
    expect(mockRegisterRoutineProposal).not.toHaveBeenCalled();
  });
});

describe('registration', () => {
  it('registers and answers the outcome verbatim', async () => {
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registered: true });
    expect(mockRegisterRoutineProposal).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      routineProse: VALID_BODY.routineProse,
      action: 'start',
      target: undefined,
    });
  });

  it('passes a refusal through untouched, still as a 200', async () => {
    // A refusal is an answer the model must read, not a transport failure.
    mockRegisterRoutineProposal.mockResolvedValue({
      registered: false,
      reason: 'open_proposal_exists',
    });
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registered: false, reason: 'open_proposal_exists' });
  });

  it('500s when registration itself breaks', async () => {
    mockRegisterRoutineProposal.mockRejectedValue(new Error('db down'));
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(500);
  });

  it('rejects a change without a target at the schema', async () => {
    const res = await post(buildApp(), { ...VALID_BODY, action: 'change' }, TOKEN);
    expect(res.status).toBe(400);
    expect(mockRegisterRoutineProposal).not.toHaveBeenCalled();
  });

  it('accepts a stop with a target and no prose, passing the action through', async () => {
    const { routineProse: _dropped, ...withoutProse } = VALID_BODY;
    const res = await post(
      buildApp(),
      { ...withoutProse, action: 'stop', target: 'the friday reminder' },
      TOKEN,
    );
    expect(res.status).toBe(200);
    expect(mockRegisterRoutineProposal).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'stop', target: 'the friday reminder', routineProse: undefined }),
    );
  });

  it('passes an ambiguous-target refusal through verbatim', async () => {
    mockRegisterRoutineProposal.mockResolvedValue({
      registered: false, reason: 'ambiguous_target', candidates: ['a', 'b'],
    });
    const res = await post(buildApp(), { ...VALID_BODY, action: 'change', target: 'it' }, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registered: false, reason: 'ambiguous_target', candidates: ['a', 'b'] });
  });
});
