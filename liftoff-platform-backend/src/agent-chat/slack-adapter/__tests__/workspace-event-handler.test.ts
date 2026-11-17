// Workspace-app inbound routing (ADR-040): binding resolution (thread beats
// channel/DM-level), picker cases, review-thread short-circuit, the
// app_mention/message.channels double-delivery guard, and the chat dispatch
// contract (workspace token source + postAs identity + implicit DM thread
// binding).

import { jest } from '@jest/globals';
import type { Response } from 'express';

const verifySigMock = jest.fn<() => boolean>();
const isDuplicateMock = jest.fn<() => Promise<boolean>>();
const publishMock = jest.fn<() => Promise<void>>();
jest.mock('../webhook-router', () => ({
  verifyWorkspaceSlackSignature: (...a: unknown[]) => verifySigMock(...(a as [])),
  isDuplicateSlackEvent: (...a: unknown[]) => isDuplicateMock(...(a as [])),
  publishSlackConnectorEvent: (...a: unknown[]) => publishMock(...(a as [])),
}));

const findInstallMock = jest.fn<() => Promise<unknown>>();
const getBindingMock = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const bindAgentMock = jest.fn<() => Promise<void>>();
const findLatestCardMock = jest.fn<() => Promise<unknown>>();
const agentNameMock = jest.fn<() => Promise<unknown>>();
const findAgentByNameMock = jest.fn<() => Promise<unknown>>();
jest.mock('../workspace-repository', () => ({
  findWorkspaceInstallByTeam: (...a: unknown[]) => findInstallMock(...(a as [])),
  getBinding: (...a: unknown[]) => getBindingMock(...a),
  getWorkspaceDefaultAgent: (...a: unknown[]) => workspaceDefaultMock(...(a as [])),
  bindAgent: (...a: unknown[]) => bindAgentMock(...(a as [])),
  findLatestReviewCardInDm: (...a: unknown[]) => findLatestCardMock(...(a as [])),
  getAgentNameAndStatus: (...a: unknown[]) => agentNameMock(...(a as [])),
  findAgentByName: (...a: unknown[]) => findAgentByNameMock(...(a as [])),
}));

const workspaceDefaultMock = jest.fn<() => Promise<string | null>>();
const resolveWsTokenMock = jest.fn<() => Promise<string | null>>();
jest.mock('../bot-token-service', () => ({
  resolveWorkspaceBotToken: (...a: unknown[]) => resolveWsTokenMock(...(a as [])),
}));

jest.mock('../workspace-app', () => ({
  getLiftoffSlackAppId: () => 'A0LIFTOFF',
}));

const slackApiFetchMock = jest.fn<() => Promise<Record<string, unknown>>>();
jest.mock('../slack-api', () => ({
  slackApiFetch: (...a: unknown[]) => slackApiFetchMock(...(a as [])),
}));

// Voice memos. Inert by default (no audio file → the real code path is skipped
// exactly as before), so only the memo tests below see a transcript.
const findAudioFileMock = jest.fn<() => unknown>();
jest.mock('../slack-files', () => ({
  findAudioFile: (...a: unknown[]) => findAudioFileMock(...(a as [])),
  downloadSlackFile: jest.fn<() => Promise<Buffer>>().mockResolvedValue(Buffer.from('audio')),
}));

const transcribeMock = jest.fn<() => Promise<unknown>>();
jest.mock('../../../voice/chat-audio', () => ({
  transcribeVoiceMemo: (...a: unknown[]) => transcribeMock(...(a as [])),
  recordMemoCost: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

const handleChatTaskMock = jest.fn<() => Promise<void>>();
// The handler now ENQUEUES the turn (chat-turn-dispatch) instead of invoking
// the worker inline; the shim forwards the queued task payload so the
// task-shape assertions below keep working. The payload carries no botToken
// (the worker re-resolves it from the install at execution time).
jest.mock('../../chat-turn-dispatch', () => ({
  enqueueChatTurnTask: (_dedupeId: string, payload: { surface: string; task: unknown }) =>
    handleChatTaskMock(payload.task as never),
  isDuplicateTaskError: () => false,
}));

const reviewReplyMock = jest.fn<() => Promise<boolean>>();
jest.mock('../review-reply-handler', () => ({
  handleReviewThreadReply: (...a: unknown[]) => reviewReplyMock(...(a as [])),
  // Real grammar — the top-level interception depends on it classifying
  // approve/reject vs ordinary chat correctly.
  parseReplyIntent: (text: string) => {
    const t = text.trim().toLowerCase();
    if (['approve', 'yes', 'send', 'ok'].includes(t)) return { kind: 'approve' };
    if (['reject', 'no', 'cancel', 'discard'].includes(t)) return { kind: 'reject' };
    if (/^(reject|no)\s*:/i.test(t)) return { kind: 'reject' };
    return { kind: 'unknown' };
  },
}));

// The suggested rung (Phase 9). Inert by default — nobody suggested — so
// every picker case below is the unbound behaviour it always was; the cases
// under "the suggested rung" opt in.
const suggestMock = jest.fn<() => Promise<{ agentId: string; probability: number } | null>>();
jest.mock('../../route-suggestion', () => ({
  suggestAnswerer: (...a: unknown[]) => suggestMock(...(a as [])),
}));
const listRouteCandidatesMock = jest.fn<() => Promise<unknown[]>>();
jest.mock('../../teams-adapter/repository', () => ({
  listRouteCandidates: (...a: unknown[]) => listRouteCandidatesMock(...(a as [])),
}));

const queryMock = jest.fn<() => Promise<{ rows: unknown[] }>>();
jest.mock('../../../infrastructure/database', () => ({
  withTenantScope: (_t: unknown, fn: (c: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { handleVerifiedWorkspaceSlackEvent, handleWorkspaceSlackEvent } from '../workspace-event-handler';

const INSTALL = {
  id: 'ws-install-1',
  tenantId: 'tenant-1',
  slackTeamId: 'T1',
  slackTeamName: 'Acme',
  slackBotUserId: 'UBOT',
  slackBotTokenSecretPath: 'projects/example-project/secrets/s/versions/latest',
  installStatus: 'installed',
  installedAt: '2026-08-01T00:00:00.000Z',
};

function makeRes(): Response & { sendStatus: jest.Mock } {
  return { sendStatus: jest.fn(), json: jest.fn() } as unknown as Response & { sendStatus: jest.Mock };
}

// The shipped path: connector-service verifies the Slack signature (it owns
// the app's single Events URL) and forwards the envelope here.
function call(event: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const res = makeRes();
  const body = { team_id: 'T1', event_id: 'Ev1', api_app_id: 'A0LIFTOFF', event, ...overrides };
  return handleVerifiedWorkspaceSlackEvent({ body, res }).then(() => res);
}

beforeEach(() => {
  jest.clearAllMocks();
  verifySigMock.mockReturnValue(true);
  isDuplicateMock.mockResolvedValue(false);
  publishMock.mockResolvedValue(undefined);
  findInstallMock.mockResolvedValue(INSTALL);
  // No workspace default unless a test sets one — the bottom rung of the
  // routing ladder is opt-in, so the picker is still the unbound behaviour.
  workspaceDefaultMock.mockResolvedValue(null);
  resolveWsTokenMock.mockResolvedValue('xoxb-ws');
  getBindingMock.mockResolvedValue(null);
  bindAgentMock.mockResolvedValue(undefined);
  slackApiFetchMock.mockResolvedValue({ ok: true });
  handleChatTaskMock.mockResolvedValue(undefined);
  reviewReplyMock.mockResolvedValue(false);
  findLatestCardMock.mockResolvedValue(null);
  findAgentByNameMock.mockResolvedValue(null);
  suggestMock.mockResolvedValue(null);
  listRouteCandidatesMock.mockResolvedValue([{ id: 'agent-reviewer', role: 'Code Reviewer', summary: 'Reviews pull requests' }]);
  // No audio unless a memo test says otherwise.
  findAudioFileMock.mockReturnValue(null);
  transcribeMock.mockResolvedValue(null);
  // a live, non-draft agent
  agentNameMock.mockResolvedValue({ displayName: 'Code Reviewer', status: 'active' });
  queryMock.mockResolvedValue({ rows: [{ display_name: 'Code Reviewer', status: 'active' }] });
});

const flush = () => new Promise((r) => setImmediate(r));

describe('workspace event handler — guards', () => {
  it('401s on a bad signature (legacy direct-to-PB entry)', async () => {
    verifySigMock.mockReturnValue(false);
    const res = makeRes();
    const body = { team_id: 'T1', event_id: 'Ev1', api_app_id: 'A0LIFTOFF', event: {} };
    await handleWorkspaceSlackEvent({
      rawBody: Buffer.from(JSON.stringify(body)), body,
      timestamp: '123', signature: 'v0=bad', res,
    });
    expect(res.sendStatus).toHaveBeenCalledWith(401);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('does NOT publish to connector-events (connector-service already did)', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '80.0' });
    await flush();
    // Double-publishing would fire every reactive subscription twice.
    expect(publishMock).not.toHaveBeenCalled();
    expect(handleChatTaskMock).toHaveBeenCalled();
  });

  it('acks and ignores an unknown workspace (no install row)', async () => {
    findInstallMock.mockResolvedValue(null);
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '1.0' });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('drops duplicate events', async () => {
    isDuplicateMock.mockResolvedValue(true);
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '1.0' });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('drops bot messages (our own customize posts carry bot_id)', async () => {
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '1.0', bot_id: 'B1' });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('ANSWERS a DM that @mentions the bot — Slack sends no app_mention for DMs', async () => {
    // Regression: the channel double-delivery guard used to apply here too,
    // so typing "@Liftoff What shipped today?" in the DM was dropped and the
    // person got silence.
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    await call({
      type: 'message', channel_type: 'im', channel: 'D1', user: 'U1',
      text: '<@UBOT> What have we shipped in the last 24 hours?', ts: '95.0',
    });
    await flush();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-9', slackChannelId: 'D1',
    }));
  });

  it('skips a plain channel message that @mentions the bot (app_mention owns it)', async () => {
    const res = await call({
      type: 'message', channel_type: 'channel', channel: 'C1', user: 'U1',
      text: 'hey <@UBOT> do the thing', ts: '5.0',
    });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(getBindingMock).not.toHaveBeenCalled();
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });
});

describe('workspace event handler — failure containment', () => {
  // Express 4 does not catch async errors: before the guard, one failing
  // query became an unhandled rejection that killed the instance and 503'd
  // every concurrent request (seen live with a wrong column name).
  it('acks 200 and logs when something throws mid-route', async () => {
    getBindingMock.mockRejectedValue(new Error('column "nope" does not exist'));
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '90.0' });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it('degrades to ordinary chat when the review-card lookup fails', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    findLatestCardMock.mockRejectedValue(new Error('db down'));
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'approve', ts: '91.0' });
    await flush();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-9' }));
  });
});

describe('workspace event handler — DM routing', () => {
  it('answers a bound top-level DM FLAT (no thread) with workspace token + postAs', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'review PR 42', ts: '10.0' });
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      agentId: 'agent-9',
      slackAppId: 'A0LIFTOFF',
      postAs: { username: 'Code Reviewer' },
      // A DM reads like a conversation, not a stack of threads.
      slackThreadTs: null,
    }));
    // The queued payload must carry NO credential — the worker re-resolves
    // the bot token from the workspace install at execution time.
    expect(handleChatTaskMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ botToken: expect.anything() }),
    );
  });

  it('a name prefix routes one message to that agent without touching the binding', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    findAgentByNameMock.mockResolvedValue({ agentId: 'agent-coder', displayName: 'Claude Coder' });
    agentNameMock.mockResolvedValue({ displayName: 'Claude Coder', status: 'active' });

    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'Claude Coder: ship it', ts: '11.0' });
    await flush();

    expect(findAgentByNameMock).toHaveBeenCalledWith('tenant-1', 'Claude Coder');
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-coder',
      postAs: { username: 'Claude Coder' },
      // the routing prefix is envelope, not content
      text: 'ship it',
    }));
    expect(bindAgentMock).not.toHaveBeenCalled();
  });

  it('a platform assistant addressed by name answers in the DM, as itself', async () => {
    // The repository resolves the three assistants ahead of the roster; the
    // handler needs nothing special to dispatch one — its reserved id rides
    // the same task a team's id does.
    getBindingMock.mockResolvedValue(null);
    findAgentByNameMock.mockResolvedValue({ agentId: 'caio', displayName: 'Chief AI Officer' });
    agentNameMock.mockResolvedValue({ displayName: 'Chief AI Officer', status: 'active' });

    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'Chief AI Officer: what teams do I have?', ts: '13.0' });
    await flush();

    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'caio',
      postAs: { username: 'Chief AI Officer' },
      text: 'what teams do I have?',
    }));
    expect(bindAgentMock).not.toHaveBeenCalled();
  });

  it('a platform assistant addressed in a channel points at the DM and runs nothing', async () => {
    getBindingMock.mockResolvedValue(null);
    findAgentByNameMock.mockResolvedValue({ agentId: 'insights', displayName: 'Insights Manager' });
    agentNameMock.mockResolvedValue({ displayName: 'Insights Manager', status: 'active' });

    await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@BOT1> Insights Manager: how much did we spend?', ts: '14.0' });
    await flush();

    expect(handleChatTaskMock).not.toHaveBeenCalled();
    const posts = slackApiFetchMock.mock.calls.filter((c) => c[0] === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    const body = (posts[0][1] as { body: { value: { channel: string; thread_ts?: string; text: string } } }).body.value;
    expect(body.channel).toBe('C1');
    expect(body.thread_ts).toBe('14.0');
    expect(body.text).toContain('Insights Manager: I answer in a direct message');
  });

  it('an unknown name prefix is ordinary text for the bound agent', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    findAgentByNameMock.mockResolvedValue(null);
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'note: check the logs', ts: '12.0' });
    await flush();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-9', text: 'note: check the logs',
    }));
  });

  it('a thread binding beats the DM-level binding', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === '7.0'
        ? { agentId: 'thread-agent', scope: 'dm' }
        : { agentId: 'dm-agent', scope: 'dm' },
    );
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'status?', ts: '8.1', thread_ts: '7.0' });
    await flush();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'thread-agent', slackThreadTs: '7.0' }));
    // Replies inside an existing thread must NOT rebind it.
    expect(bindAgentMock).not.toHaveBeenCalled();
  });

  it('posts the picker when the DM has no binding, holding the question for the chosen agent', async () => {
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello', ts: '2.0' });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    const [, opts] = slackApiFetchMock.mock.calls[0] as [string, { body: { value: Record<string, unknown> } }];
    expect(opts.body.value.channel).toBe('D1');
    const blocks = opts.body.value.blocks as Array<{ block_id: string }>;
    // …|<threadRootTs>|<pendingTs> — the message that opened the picker
    expect(blocks[0].block_id).toBe('liftoff_pickctx|dm|D1||2.0');
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('"switch" re-opens the picker with nothing held (there is no question in it)', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'switch', ts: '3.0' });
    const [, opts] = slackApiFetchMock.mock.calls[0] as [string, { body: { value: Record<string, unknown> } }];
    const blocks = opts.body.value.blocks as Array<{ block_id: string }>;
    expect(blocks[0].block_id).toBe('liftoff_pickctx|dm|D1||');
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('short-circuits into the review-thread reply handler before chat routing', async () => {
    reviewReplyMock.mockResolvedValue(true);
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'approve', ts: '9.1', thread_ts: '9.0' });
    expect(reviewReplyMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', rootTs: '9.0', botToken: 'xoxb-ws',
    }));
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(getBindingMock).not.toHaveBeenCalled();
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('a TOP-LEVEL "approve" resolves the most recent card and acks where it was typed', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    findLatestCardMock.mockResolvedValue({ reviewId: 'rev-1', rootTs: '50.0' });
    reviewReplyMock.mockResolvedValue(true);

    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'approve', ts: '51.0' });

    expect(findLatestCardMock).toHaveBeenCalledWith('tenant-1', 'T1', 'D1');
    expect(reviewReplyMock).toHaveBeenCalledWith(expect.objectContaining({
      rootTs: '50.0',
      // null = post the confirmation top-level, not inside an unopened thread
      ackThreadTs: null,
    }));
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('ordinary top-level chat is NOT intercepted even with a card present', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    findLatestCardMock.mockResolvedValue({ reviewId: 'rev-1', rootTs: '50.0' });

    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'what is the status?', ts: '52.0' });
    await flush();

    expect(reviewReplyMock).not.toHaveBeenCalled();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-9' }));
  });

  it('a top-level "approve" with no card in the DM falls through to chat', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    findLatestCardMock.mockResolvedValue(null);
  findAgentByNameMock.mockResolvedValue(null);

    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'approve', ts: '53.0' });
    await flush();

    expect(reviewReplyMock).not.toHaveBeenCalled();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-9' }));
  });

  it('an in-thread reply still routes by thread root (ack defaults into the thread)', async () => {
    reviewReplyMock.mockResolvedValue(true);
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'approve', ts: '61.0', thread_ts: '60.0' });
    expect(reviewReplyMock).toHaveBeenCalledWith(expect.objectContaining({ rootTs: '60.0' }));
    expect(reviewReplyMock.mock.calls[0][0]).not.toHaveProperty('ackThreadTs');
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  it('tells the person when the agent is paused, in place of a reply', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    agentNameMock.mockResolvedValue({ displayName: 'Code Reviewer', status: 'paused' });

    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '70.0' });

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
    const [, opts] = slackApiFetchMock.mock.calls[0] as [string, { body: { value: Record<string, unknown> } }];
    // Liftoff speaks here, not the agent: a paused teammate cannot answer.
    expect(opts.body.value.text).toBe('Liftoff: Code Reviewer is paused right now');
    // Flat in a DM, like every other reply.
    expect(opts.body.value.thread_ts).toBeUndefined();
  });

  it('threads the paused notice under the mention in a channel', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'chan-agent', scope: 'channel' } : null,
    );
    agentNameMock.mockResolvedValue({ displayName: 'Claude Coder', status: 'paused' });

    await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> status?', ts: '71.0' });

    const [, opts] = slackApiFetchMock.mock.calls[0] as [string, { body: { value: Record<string, unknown> } }];
    expect(opts.body.value.text).toBe('Liftoff: Claude Coder is paused right now');
    expect(opts.body.value.thread_ts).toBe('71.0');
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('silently ignores a draft agent', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    agentNameMock.mockResolvedValue({ displayName: 'Draft Team', status: 'draft' });
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '4.0' });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });
});

describe('workspace event handler — channel routing', () => {
  it('an app_mention with no binding posts the picker into the mention thread with a channel-level context', async () => {
    const res = await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> hi', ts: '20.0' });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    const [, opts] = slackApiFetchMock.mock.calls[0] as [string, { body: { value: Record<string, unknown> } }];
    expect(opts.body.value.channel).toBe('C1');
    expect(opts.body.value.thread_ts).toBe('20.0');
    // Channel-level binding (empty threadRootTs) + the mention's ts held, so
    // whoever is picked answers what was actually asked.
    const blocks = opts.body.value.blocks as Array<{ block_id: string }>;
    expect(blocks[0].block_id).toBe('liftoff_pickctx|channel|C1||20.0');
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('a bare "@Liftoff" holds nothing (there is no question in it)', async () => {
    const res = await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT>', ts: '25.0' });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    const [, opts] = slackApiFetchMock.mock.calls[0] as [string, { body: { value: Record<string, unknown> } }];
    const blocks = opts.body.value.blocks as Array<{ block_id: string }>;
    expect(blocks[0].block_id).toBe('liftoff_pickctx|channel|C1||');
  });

  it('an app_mention in a bound channel answers IN A THREAD under the mention', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'chan-agent', scope: 'channel' } : null,
    );
    await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> ship it', ts: '21.0' });
    await flush();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'chan-agent', slackChannelId: 'C1',
      // channels keep bot replies threaded so the channel stays readable
      slackThreadTs: '21.0',
    }));
  });

  it('IGNORES unaddressed chatter in a bound channel (binding is not a licence to join in)', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'chan-agent', scope: 'channel' } : null,
    );
    const res = await call({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U1', text: 'build is red', ts: '22.0' });
    await flush();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
    expect(slackApiFetchMock).not.toHaveBeenCalled();
  });

  it('answers a name-prefixed channel message without a mention', async () => {
    getBindingMock.mockResolvedValue(null);
    findAgentByNameMock.mockResolvedValue({ agentId: 'agent-coder', displayName: 'Claude Coder' });
    agentNameMock.mockResolvedValue({ displayName: 'Claude Coder', status: 'active' });
    await call({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U1', text: 'Claude Coder: status?', ts: '24.0' });
    await flush();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'agent-coder', text: 'status?', slackThreadTs: '24.0',
    }));
  });

  it('answers a reply inside a thread the bot already owns', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === '30.0' ? { agentId: 'chan-agent', scope: 'channel' } : null,
    );
    await call({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U1', text: 'and the tests?', ts: '31.0', thread_ts: '30.0' });
    await flush();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'chan-agent', slackThreadTs: '30.0',
    }));
  });

  it('plain chatter in an UNbound channel is ignored (no picker spam)', async () => {
    const res = await call({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U1', text: 'lunch?', ts: '23.0' });
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(slackApiFetchMock).not.toHaveBeenCalled();
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });
});

describe('workspace event handler — the workspace default', () => {
  it('answers a DM from the workspace default when nothing else is bound', async () => {
    // The bottom rung. Without it the only answer to "nobody has chosen yet"
    // is the picker, which a workspace that talks to one team member has to
    // dismiss in every new conversation.
    getBindingMock.mockResolvedValue(null);
    workspaceDefaultMock.mockResolvedValue('agent-default');
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello', ts: '30.0' });
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-default' }));
    // And no picker: being asked anyway would defeat the point.
    expect(slackApiFetchMock).not.toHaveBeenCalled();
  });

  it('never consults the default when a binding already answered', async () => {
    // A round trip per message, in every connected workspace, for a value
    // almost none of them set.
    getBindingMock.mockImplementation(async (_t: unknown, _team: unknown, _ch: unknown, threadTs: unknown) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '31.0' });
    await flush();
    expect(workspaceDefaultMock).not.toHaveBeenCalled();
  });

  it('does not make the bot answer un-addressed channel traffic', async () => {
    // The single most important property of the new rung: it changes WHO
    // answers, never WHETHER the bot speaks. A workspace default that turned
    // the bot into a participant in every channel would be a broadcast.
    getBindingMock.mockResolvedValue(null);
    workspaceDefaultMock.mockResolvedValue('agent-default');
    const res = await call({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U1', text: 'unrelated chatter', ts: '32.0' });
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
    expect(slackApiFetchMock).not.toHaveBeenCalled();
  });

  it('answers an @mention from the default rather than showing the picker', async () => {
    getBindingMock.mockResolvedValue(null);
    workspaceDefaultMock.mockResolvedValue('agent-default');
    await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> can you look at this', ts: '33.0' });
    await flush();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-default' }));
  });

  it('still shows the picker on an explicit switch, because the default is not a choice', async () => {
    getBindingMock.mockResolvedValue(null);
    workspaceDefaultMock.mockResolvedValue('agent-default');
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'switch', ts: '34.0' });
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
    expect(slackApiFetchMock).toHaveBeenCalled();
  });

  it('falls through to the picker when the default cannot be read', async () => {
    // A convenience that can swallow a turn costs more than the click it saves.
    getBindingMock.mockResolvedValue(null);
    workspaceDefaultMock.mockRejectedValue(new Error('db down'));
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello', ts: '35.0' });
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(slackApiFetchMock).toHaveBeenCalled();
  });
});

describe('workspace event handler — the suggested rung', () => {
  it('answers a DM from the suggested team when the four rungs are empty, without binding', async () => {
    getBindingMock.mockResolvedValue(null);
    workspaceDefaultMock.mockResolvedValue(null);
    suggestMock.mockResolvedValue({ agentId: 'agent-reviewer', probability: 0.91 });
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'can you review PR 412', ts: '40.0' });
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(suggestMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', message: 'can you review PR 412', channel: { kind: 'dm' }, surface: 'slack',
      candidates: [{ id: 'agent-reviewer', role: 'Code Reviewer', summary: 'Reviews pull requests' }],
    }));
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-reviewer' }));
    expect(bindAgentMock).not.toHaveBeenCalled();
    expect(slackApiFetchMock).not.toHaveBeenCalled();
  });

  it('is consulted only when the four rungs above are empty: no roster query on a bound message', async () => {
    getBindingMock.mockImplementation(async (_t: unknown, _team: unknown, _ch: unknown, threadTs: unknown) =>
      threadTs === null ? { agentId: 'agent-9', scope: 'dm' } : null,
    );
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '41.0' });
    await flush();
    expect(listRouteCandidatesMock).not.toHaveBeenCalled();
    expect(suggestMock).not.toHaveBeenCalled();
  });

  it('sits after the workspace default', async () => {
    getBindingMock.mockResolvedValue(null);
    workspaceDefaultMock.mockResolvedValue('agent-default');
    suggestMock.mockResolvedValue({ agentId: 'agent-reviewer', probability: 0.91 });
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello', ts: '42.0' });
    await flush();
    expect(suggestMock).not.toHaveBeenCalled();
    expect(handleChatTaskMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-default' }));
  });

  it('never answers an un-addressed channel message from it', async () => {
    getBindingMock.mockResolvedValue(null);
    suggestMock.mockResolvedValue({ agentId: 'agent-reviewer', probability: 0.99 });
    const res = await call({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U1', text: 'review PR 412 please', ts: '43.0' });
    await flush();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(suggestMock).not.toHaveBeenCalled();
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('posts the picker on none / sub-threshold / null (the suggestion answers null for all three)', async () => {
    getBindingMock.mockResolvedValue(null);
    suggestMock.mockResolvedValue(null);
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hi', ts: '44.0' });
    await flush();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(handleChatTaskMock).not.toHaveBeenCalled();
    expect(slackApiFetchMock).toHaveBeenCalled();
  });

  it('never consults it on a switch', async () => {
    getBindingMock.mockResolvedValue(null);
    suggestMock.mockResolvedValue({ agentId: 'agent-reviewer', probability: 0.99 });
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'switch', ts: '45.0' });
    await flush();
    expect(suggestMock).not.toHaveBeenCalled();
    expect(slackApiFetchMock).toHaveBeenCalled();
  });

  it('falls to the picker when the roster cannot be read', async () => {
    getBindingMock.mockResolvedValue(null);
    listRouteCandidatesMock.mockRejectedValue(new Error('db down'));
    suggestMock.mockResolvedValue(null);
    const res = await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello', ts: '46.0' });
    await flush();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(suggestMock).toHaveBeenCalledWith(expect.objectContaining({ candidates: [] }));
    expect(slackApiFetchMock).toHaveBeenCalled();
  });

  it('writes the audit line with rung suggested and the probability', async () => {
    const { log } = jest.requireMock('../../../infrastructure/logging') as { log: { info: jest.Mock } };
    getBindingMock.mockResolvedValue(null);
    suggestMock.mockResolvedValue({ agentId: 'agent-reviewer', probability: 0.87 });
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'review PR 412', ts: '47.0' });
    await flush();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'slack_turn_routed', rung: 'suggested', probability: 0.87 }),
      expect.any(String),
    );
  });
});

// A mention with nothing after it. `text` is stripped of mentions, so it is
// empty here while rawText still holds "<@UBOT>" — the handler used to test
// rawText at the enqueue, ship the raw mention, and let the worker strip it a
// second time down to "". That reached the runtime client as an empty
// userMessage, which throws before it calls fetch, and the person was told
// "We could not reach the agent right now".
describe('workspace event handler — a bare mention has nothing to answer', () => {
  /** Bind the channel/DM itself, leaving threads unbound. */
  function channelBound(agentId: string) {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId, scope: 'channel' } : null,
    );
  }
  /** Bind one thread, the rung that counts as a deliberate choice. */
  function threadBound(agentId: string, ts: string) {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === ts ? { agentId, scope: 'thread' } : null,
    );
  }
  const lastPost = () =>
    (slackApiFetchMock.mock.calls[0] as [string, { body: { value: Record<string, unknown> } }])[1]
      .body.value;

  it('asks who, rather than erroring, when the CHANNEL is bound (the reported case)', async () => {
    channelBound('channel-agent');
    const res = await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT>', ts: '40.0' });
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    // The picker, with nothing held: there is no question in a bare mention.
    const blocks = lastPost().blocks as Array<{ block_id: string }>;
    expect(blocks[0].block_id).toBe('liftoff_pickctx|channel|C1||');
    // Nothing may reach the runtime — an empty message is what broke it.
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('asks who when only the workspace DEFAULT would answer', async () => {
    getBindingMock.mockResolvedValue(null);
    workspaceDefaultMock.mockResolvedValue('agent-default');
    const res = await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT>', ts: '41.0' });
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(lastPost().blocks).toBeDefined();
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('greets instead of asking inside a thread that already belongs to someone', async () => {
    // Picking from the picker BINDS, so offering one here would let a stray
    // mention rebind a thread somebody is working in. Same rule switchIsAllowed
    // applies to an explicit "switch".
    threadBound('thread-agent', '42.0');
    agentNameMock.mockResolvedValue({ displayName: 'Claude Coder', status: 'active' });
    const res = await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT>', ts: '42.1', thread_ts: '42.0' });
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    const posted = lastPost();
    expect(posted.text).toBe('Liftoff: Claude Coder here. What can I help with?');
    expect(posted.blocks).toBeUndefined();
    expect(posted.thread_ts).toBe('42.0');
    expect(bindAgentMock).not.toHaveBeenCalled();
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('reports paused rather than greeting, when the bound teammate is paused', async () => {
    threadBound('thread-agent', '43.0');
    agentNameMock.mockResolvedValue({ displayName: 'Claude Coder', status: 'paused' });
    await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT>', ts: '43.1', thread_ts: '43.0' });
    await flush();

    expect(lastPost().text).toBe('Liftoff: Claude Coder is paused right now');
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('treats a message that is only a mention of somebody else the same way', async () => {
    // stripBotMentions drops every mention, so this normalizes empty too and
    // hit the identical crash.
    threadBound('thread-agent', '44.0');
    await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@U0HUMAN>', ts: '44.1', thread_ts: '44.0' });
    await flush();

    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('a bare mention in a bound DM asks who, and enqueues nothing', async () => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'dm-agent', scope: 'dm' } : null,
    );
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: '<@UBOT>', ts: '45.0' });
    await flush();

    expect(lastPost().blocks).toBeDefined();
    expect(handleChatTaskMock).not.toHaveBeenCalled();
  });

  it('still enqueues the RAW text when there is something to answer', async () => {
    // The payload stays rawText so the worker's own normalization (channel
    // mentions, labeled URLs) still runs. Only the emptiness TEST changed.
    channelBound('channel-agent');
    await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> ship it', ts: '46.0' });
    await flush();

    expect(handleChatTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'channel-agent', text: '<@UBOT> ship it' }),
    );
  });
});

// The enqueued payload is rawText so the worker can do the fuller
// normalization (channel mentions, labeled URLs). A voice memo has no rawText
// at all, so the predicate choosing between them must read what rawText holds
// on its OWN — not the joined text, which already contains the transcript.
describe('workspace event handler — a spoken message still sends the transcript', () => {
  function memo(transcript: string) {
    findAudioFileMock.mockReturnValue({ id: 'F1', url_private_download: 'https://files/f1' });
    transcribeMock.mockResolvedValue({ transcript, durationSeconds: 3, costUsd: 0.001 });
  }
  beforeEach(() => {
    getBindingMock.mockImplementation(async (_t, _team, _ch, threadTs) =>
      threadTs === null ? { agentId: 'dm-agent', scope: 'dm' } : null,
    );
  });

  it('enqueues the transcript for a memo with no text', async () => {
    memo('ship the release notes');
    await call({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', ts: '50.0', files: [{ id: 'F1' }] });
    await flush();

    expect(handleChatTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'ship the release notes', spokenInput: true }),
    );
  });

  it('enqueues the transcript for a memo posted WITH a mention, not the mention', async () => {
    // rawText is "<@UBOT>", which normalizes to nothing downstream — the same
    // empty message that broke the bare-mention case.
    memo('ship the release notes');
    await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT>', ts: '51.0', files: [{ id: 'F1' }] });
    await flush();

    expect(handleChatTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'ship the release notes', spokenInput: true }),
    );
  });

  it('sends rawText when the person typed alongside the memo', async () => {
    memo('and here is why');
    await call({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> look at this', ts: '52.0', files: [{ id: 'F1' }] });
    await flush();

    expect(handleChatTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: '<@UBOT> look at this' }),
    );
  });
});
