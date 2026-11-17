// The settle backstop attributes a reply the same way the live path does.
//
// A reply that reaches the thread through this callback — the tab was gone
// before the stream finished — is the only copy the person will ever read.
// If the live consumer writes who the team handed work to and this one does
// not, a person who closed the tab sees a reply with no chips where a person
// who kept it open sees two, which is not a property a transcript should
// have. The same ids go through the same resolver and land in the same
// column.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import express from 'express';
import request from 'supertest';

const appendMessage = jest.fn();
const countFileCards = jest.fn();
const resolveContributors = jest.fn();

jest.mock('../chat-repository', () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  countFileCardsProducedInTurn: (...a: unknown[]) => countFileCards(...a),
}));
jest.mock('../contributors', () => ({
  resolveContributors: (...a: unknown[]) => resolveContributors(...a),
}));
jest.mock('../out-of-turn-delivery', () => ({
  notifyReplyPersisted: jest.fn(),
}));
jest.mock('../../injection-detection/gating', () => ({
  screenPersistedContent: jest.fn().mockResolvedValue({ block: false }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { settleTurnRouter } from '../settle-turn-router';

const app = express();
app.use(settleTurnRouter);

const body = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  threadId: '22222222-2222-2222-2222-222222222222',
  agentId: '33333333-3333-3333-3333-333333333333',
  turnId: '44444444-4444-4444-4444-444444444444',
  replyText: 'Reviewed with the team.',
};

const post = (payload: Record<string, unknown>) =>
  request(app).post('/settle-turn').set('x-service-auth', 'test-token').send(payload);

/** The 15th positional argument of appendMessage is `contributors`. */
const persistedContributors = () => appendMessage.mock.calls[0][14];

beforeEach(() => {
  process.env.PLATFORM_CALLBACK_TOKEN = 'test-token';
  appendMessage.mockReset().mockResolvedValue({ id: 'msg-1' });
  countFileCards.mockReset().mockResolvedValue({ attributed: 0, unattributed: 0 });
  resolveContributors.mockReset().mockImplementation(async (_tenantId: string, ids: string[]) =>
    ids.map((id) => ({ id: `internal-${id}`, label: `Team ${id}` })),
  );
});

describe('settle-turn persists who the reply is attributed to', () => {
  it('resolves delegatedTo through the shared resolver and writes the result on the row', async () => {
    const res = await post({ ...body, delegatedTo: ['rt-8', 'rt-7'] });

    expect(res.status).toBe(200);
    expect(resolveContributors).toHaveBeenCalledWith(body.tenantId, ['rt-8', 'rt-7']);
    expect(persistedContributors()).toEqual([
      { id: 'internal-rt-8', label: 'Team rt-8' },
      { id: 'internal-rt-7', label: 'Team rt-7' },
    ]);
  });

  it('writes [] when an older runtime says nothing about hand-overs', async () => {
    const res = await post(body);

    expect(res.status).toBe(200);
    expect(resolveContributors).toHaveBeenCalledWith(body.tenantId, []);
    expect(persistedContributors()).toEqual([]);
  });

  it('never attributes narration: a run_progress notice carries [] even when the run delegated', async () => {
    const res = await post({ ...body, messageType: 'run_progress', delegatedTo: ['rt-7'] });

    expect(res.status).toBe(200);
    expect(resolveContributors).not.toHaveBeenCalled();
    expect(persistedContributors()).toEqual([]);
  });

  it('refuses a delegatedTo that is not a list of ids', async () => {
    const res = await post({ ...body, delegatedTo: 'rt-7' });

    expect(res.status).toBe(400);
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
