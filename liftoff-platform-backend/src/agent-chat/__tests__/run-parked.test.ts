// A run that outgrew its chat turn.
//
// The runtime parks it, continues it in a fresh invocation, and delivers the
// answer when it lands. Between those two moments the thread has to say so, or
// the person is looking at the same blank page that a dead run leaves -- which
// is the failure the continuation was built to end, reproduced one layer up.
//
// Two paths write that notice and they must not both leave one: the live stream
// (this turn is still connected) and the runtime's settle callback (the tab is
// usually gone by the time a run outgrows ten minutes). Both key it to the TURN,
// so the one-assistant-row-per-turn index makes the loser a no-op.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import express from 'express';
import request from 'supertest';

const appendMessage = jest.fn();
const notifyReplyPersisted = jest.fn();

jest.mock('../chat-repository', () => ({
  appendMessage: (...a: unknown[]) => appendMessage(...a),
}));
jest.mock('../out-of-turn-delivery', () => ({
  notifyReplyPersisted: (...a: unknown[]) => notifyReplyPersisted(...a),
}));
jest.mock('../../injection-detection/gating', () => ({
  screenPersistedContent: jest.fn().mockResolvedValue({ block: false }),
}));

import { settleTurnRouter } from '../settle-turn-router';
import { RUN_PROGRESS_MESSAGE_TYPE } from '../run-progress';

const app = express();
app.use(settleTurnRouter);

const body = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  threadId: '22222222-2222-2222-2222-222222222222',
  agentId: '33333333-3333-3333-3333-333333333333',
  turnId: '44444444-4444-4444-4444-444444444444',
  replyText: 'This is taking longer than one chat turn. It is continuing in the background.',
};

beforeEach(() => {
  process.env.PLATFORM_CALLBACK_TOKEN = 'test-token';
  appendMessage.mockReset().mockResolvedValue({ id: 'msg-1' });
  notifyReplyPersisted.mockReset();
});

const post = (payload: Record<string, unknown>) =>
  request(app).post('/settle-turn').set('x-service-auth', 'test-token').send(payload);

describe('settling a notice that a run is still going', () => {
  it('stores it as narration rather than as the team speaking', async () => {
    const res = await post({ ...body, messageType: RUN_PROGRESS_MESSAGE_TYPE });

    expect(res.status).toBe(200);
    // Positional API: message_type is the 9th argument.
    expect(appendMessage.mock.calls[0][8]).toBe(RUN_PROGRESS_MESSAGE_TYPE);
    // Keyed to the turn, so the live path and this one cannot both leave a row.
    expect(appendMessage.mock.calls[0][11]).toBe(body.turnId);
  });

  it('does not tell anyone an answer arrived', async () => {
    // A push that says "your answer is here" for a notice that the work is
    // still running teaches people to open a thread with nothing new in it.
    await post({ ...body, messageType: RUN_PROGRESS_MESSAGE_TYPE });
    expect(notifyReplyPersisted).not.toHaveBeenCalled();
  });

  it('still pushes for an actual reply', async () => {
    await post(body);
    expect(appendMessage.mock.calls[0][8]).toBeUndefined();
    expect(notifyReplyPersisted).toHaveBeenCalledTimes(1);
  });

  it('refuses to be told what kind of row to write', async () => {
    // The message type decides whether a row counts as a reply, whether it
    // reaches the model as history, and how it renders. A caller does not get
    // to name it: only the one narration type is accepted.
    const res = await post({ ...body, messageType: 'hitl_status' });
    expect(res.status).toBe(400);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('treats the other path having won as success, not as an error', async () => {
    appendMessage.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const res = await post({ ...body, messageType: RUN_PROGRESS_MESSAGE_TYPE });
    expect(res.status).toBe(200);
    expect(res.body.alreadyPersisted).toBe(true);
  });
});

describe('the live path writes the same notice', () => {
  const svc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'chat-service.ts'), 'utf8',
  ) as string;
  const branch = svc.slice(svc.indexOf("case 'run_parked': {"), svc.indexOf("case 'delegation_started': {"));

  it('keys it to the turn so it cannot duplicate the settled row', () => {
    expect(branch).toContain('RUN_PROGRESS_MESSAGE_TYPE');
    expect(branch).toMatch(/turnId,\s*\n\s*\);/);
  });

  it('swallows the losing side of that race and nothing else', () => {
    expect(branch).toMatch(/code !== '23505'/);
  });

  it('ends the turn rather than waiting for events that will not come', () => {
    // The runtime writes exactly one frame for a pause and closes the stream.
    expect(branch).toContain("yield { type: 'complete', message: null };");
    expect(branch).toContain('return;');
  });

  it('does not stamp the reply clock, because nothing was answered', () => {
    const repo = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'chat-repository.ts'), 'utf8',
    ) as string;
    const start = repo.indexOf('const isTeamReply');
    expect(repo.slice(start, repo.indexOf(';', start))).toContain('RUN_PROGRESS_MESSAGE_TYPE');
  });
});
