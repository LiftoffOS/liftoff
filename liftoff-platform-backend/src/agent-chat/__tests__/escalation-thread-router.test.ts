// The escalation thread: append when the run came from chat, open a new one
// when it did not.
//
// The discriminator is a LOOKUP, never a caller-supplied flag. A chat-origin
// run carries our thread id (the runtime mirrors it into its own table under
// the same uuid); an autonomous run carries an id that exists only over there.
// Trusting a hint about which is which would be a second source of truth about
// an id space that has already produced exactly this class of bug.

import request from 'supertest';
import express from 'express';

const getThread = jest.fn();
const findOrCreateThread = jest.fn();
const appendMessage = jest.fn();
const updateThreadTitleInternal = jest.fn();

jest.mock('../chat-repository', () => ({
  getThread: (...a: unknown[]) => getThread(...a),
  findOrCreateThread: (...a: unknown[]) => findOrCreateThread(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
  updateThreadTitleInternal: (...a: unknown[]) => updateThreadTitleInternal(...a),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { escalationThreadRouter } from '../escalation-thread-router';

const TOKEN = 'callback-token';
const TENANT = '00000000-0000-0000-0000-0000000000a1';
const AGENT = '00000000-0000-0000-0000-0000000000a2';
const ESCALATION = '00000000-0000-0000-0000-0000000000a3';
const CHAT_THREAD = '00000000-0000-0000-0000-0000000000a4';
const NEW_THREAD = '00000000-0000-0000-0000-0000000000a5';

function app() {
  const a = express();
  a.use('/api/internal/agent-chat', escalationThreadRouter);
  return a;
}

function post(body: Record<string, unknown>) {
  return request(app())
    .post('/api/internal/agent-chat/escalation-thread')
    .set('X-Service-Auth', TOKEN)
    .send(body);
}

const baseBody = {
  tenantId: TENANT,
  internalAgentId: AGENT,
  escalationId: ESCALATION,
  reason: 'Grant the service account access to the sheet.',
};

beforeAll(() => { process.env.PLATFORM_CALLBACK_TOKEN = TOKEN; });

beforeEach(() => {
  getThread.mockReset().mockResolvedValue(null);
  findOrCreateThread.mockReset().mockResolvedValue({ id: NEW_THREAD });
  appendMessage.mockReset().mockResolvedValue({ id: 'msg-1' });
  updateThreadTitleInternal.mockReset().mockResolvedValue(undefined);
});

describe('auth', () => {
  it('refuses without the callback token', async () => {
    const res = await request(app())
      .post('/api/internal/agent-chat/escalation-thread')
      .send(baseBody);
    expect(res.status).toBe(401);
    expect(appendMessage).not.toHaveBeenCalled();
  });
});

describe('a chat-origin run', () => {
  it('appends to the conversation it came from rather than starting a new one', async () => {
    getThread.mockResolvedValue({ id: CHAT_THREAD });

    const res = await post({ ...baseBody, threadId: CHAT_THREAD });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ threadId: CHAT_THREAD, created: false });
    expect(findOrCreateThread).not.toHaveBeenCalled();
    expect(appendMessage.mock.calls[0][1]).toBe(CHAT_THREAD);
  });

  it('does not rename a conversation it merely joined', async () => {
    getThread.mockResolvedValue({ id: CHAT_THREAD });

    await post({ ...baseBody, threadId: CHAT_THREAD, title: 'Grant access' });

    expect(updateThreadTitleInternal).not.toHaveBeenCalled();
  });
});

describe('an autonomous run', () => {
  it('opens its own thread when the id is not one of ours', async () => {
    // A runtime-minted id: present over there, absent here. The lookup miss is
    // the whole discriminator.
    getThread.mockResolvedValue(null);

    const res = await post({ ...baseBody, threadId: '00000000-0000-0000-0000-0000000000ff' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ threadId: NEW_THREAD, created: true });
    expect(findOrCreateThread).toHaveBeenCalled();
  });

  it('opens a thread when the run carried none at all', async () => {
    const res = await post(baseBody);

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(true);
    expect(getThread).not.toHaveBeenCalled();
  });

  it('keys the new thread on the escalation, so a redelivery cannot double up', async () => {
    await post(baseBody);

    expect(findOrCreateThread).toHaveBeenCalledWith(
      TENANT, null, AGENT, 'web', `escalation:${ESCALATION}`,
    );
  });

  it('titles it, so a team\'s escalations are not a column of identical rows', async () => {
    await post({ ...baseBody, title: 'Grant access to the sheet' });

    expect(updateThreadTitleInternal).toHaveBeenCalledWith(
      NEW_THREAD, TENANT, 'Grant access to the sheet',
    );
  });

  it('still posts the message when the thread cannot be titled', async () => {
    updateThreadTitleInternal.mockRejectedValue(new Error('nope'));

    const res = await post({ ...baseBody, title: 'Grant access' });

    expect(res.status).toBe(200);
    expect(appendMessage).toHaveBeenCalled();
  });
});

describe('the message itself', () => {
  it('carries a message_type, without which the thread would never be listed', async () => {
    await post(baseBody);

    // The thread list and the unread counts both admit an assistant message
    // only when it has a turn or a type. No type, no thread on screen.
    const call = appendMessage.mock.calls[0];
    expect(call[2]).toBe('assistant');
    expect(call[3]).toBe(baseBody.reason);
    expect(call[8]).toBe('escalation');
  });

  it('keys the retry on the message\'s own ref, NOT on turn_id', async () => {
    // This assertion used to require the opposite, and passed for six weeks
    // while the route wrote nothing at all: `turn_id` is a foreign key into
    // agent_chat_turns (migration 294) and an escalation id is not a turn, so
    // every insert was rejected. appendMessage is mocked here, so the mock
    // happily accepted an argument the database never would.
    //
    // The lesson is in the shape of the old test, not just its value: it
    // asserted the MECHANISM the code had chosen rather than the outcome the
    // route exists for, so it could only ever confirm the code did what it said.
    await post(baseBody);

    const call = appendMessage.mock.calls[0];
    expect(call[11]).toBeUndefined();
    expect(call[12]).toBe(`escalation:${ESCALATION}`);
  });

  it('answers a redelivery with the existing thread rather than an error', async () => {
    appendMessage.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    findOrCreateThread.mockResolvedValue({ id: NEW_THREAD });

    const res = await post(baseBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ threadId: NEW_THREAD, alreadyThreaded: true });
  });
});

describe('validation', () => {
  it('rejects a runtime-space agent id shape it cannot attach a message to', async () => {
    const res = await post({ ...baseBody, internalAgentId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty blocker, which would post a blank message', async () => {
    const res = await post({ ...baseBody, reason: '' });
    expect(res.status).toBe(400);
  });
});
