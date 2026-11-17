// Reply notifications for Liftoff, Insights and the team plan.
//
// These three surfaces asked for notification permission and could never
// deliver: the notify path existed only for agent chat. The tests that matter
// are the ones that stop the feature being silently wrong again — the right
// person is told, the link carries no ids, and somebody watching the reply
// arrive is left alone.

const enqueueNotificationMock = jest.fn();
const pushOutOfTurnMock = jest.fn().mockResolvedValue({ channel: null, pushed: null });
jest.mock('../../agent-chat/assistant-out-of-turn', () => ({
  pushAssistantOutOfTurnMessage: (...a: unknown[]) => pushOutOfTurnMock(...a),
}));
jest.mock('../service', () => ({
  enqueueNotification: (...a: unknown[]) => enqueueNotificationMock(...a),
}));

const findOrCreateLinkMock = jest.fn();
jest.mock('../../notification-links', () => ({
  findOrCreateLink: (...a: unknown[]) => findOrCreateLinkMock(...a),
}));

const logInfoMock = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: (...a: unknown[]) => logInfoMock(...a),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const isAccountPresentMock = jest.fn();
jest.mock('../../common/chat-presence-repository', () => ({
  isAccountPresent: (...a: unknown[]) => isAccountPresentMock(...a),
}));

import { notifyPlatformChatReply } from '../platform-chat-notify';

const TENANT = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const ACCOUNT = '33333333-3333-3333-3333-333333333333';
const ORIGINAL_URL = process.env.FRONTEND_URL;

beforeEach(() => {
  jest.clearAllMocks();
  pushOutOfTurnMock.mockResolvedValue({ channel: null, pushed: null });
  process.env.FRONTEND_URL = 'https://example.com';
  isAccountPresentMock.mockResolvedValue(false);
  findOrCreateLinkMock.mockResolvedValue('link-1');
  enqueueNotificationMock.mockResolvedValue({ pushedDevices: 1, emailed: false });
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL_URL;
});

function call(overrides: Record<string, unknown> = {}) {
  return notifyPlatformChatReply({
    tenantId: TENANT,
    surface: 'liftoff',
    threadId: THREAD,
    accountId: ACCOUNT,
    text: 'Here is the answer.',
    ...overrides,
  } as Parameters<typeof notifyPlatformChatReply>[0]);
}

describe('notifyPlatformChatReply', () => {
  // The person who asked is the person waiting. These surfaces are
  // workspace-wide, so the thread's creator is often somebody else entirely.
  it('notifies whoever asked', async () => {
    await call();
    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
    const arg = enqueueNotificationMock.mock.calls[0][0];
    expect(arg.accountId).toBe(ACCOUNT);
    expect(arg.tenantId).toBe(TENANT);
    expect(arg.type).toBe('task_update');
    expect(arg.payload.eventSummary).toBe('Here is the answer.');
  });

  // An answer goes back where the question came from, as a team's does. A
  // turn that came through Slack or Teams was answered there by the worker
  // that ran it, so this notice would be the same answer a second time.
  it('says nothing when the turn came through a chat workspace: the surface that ran it already answered there', async () => {
    await call({ surface: 'liftoff', via: 'slack' });
    await call({ surface: 'team_plan', via: 'teams' });
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });

  // A plan that finishes minutes after the person said yes in a Slack DM is
  // answered in that DM, under the assistant's name, and nowhere else.
  it('delivers a message written between turns to the chat workspace the thread is bound to, and nowhere else', async () => {
    pushOutOfTurnMock.mockResolvedValueOnce({ channel: 'slack', pushed: true });
    await call({ surface: 'team_plan', text: 'Your teams are set up and started.' });
    expect(pushOutOfTurnMock).toHaveBeenCalledWith({ tenantId: TENANT, kind: 'caio', threadId: THREAD, text: 'Your teams are set up and started.' });
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
    expect(findOrCreateLinkMock).not.toHaveBeenCalled();
  });

  it('falls back to the dashboard notice when the thread is bound to no chat workspace', async () => {
    await call({ surface: 'liftoff' });
    expect(pushOutOfTurnMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'liftoff' }));
    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('still notifies a turn that came through a coding tool', async () => {
    await call({ surface: 'liftoff', via: 'mcp' });
    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
  });

  // Internal ids must not travel in a URL. The link is opaque and resolves
  // server-side.
  it('carries an opaque link, not the thread id', async () => {
    await call();
    const link = enqueueNotificationMock.mock.calls[0][0].payload.eventLink as string;
    expect(link).toBe('https://example.com/notification/link-1');
    expect(link).not.toContain(THREAD);
  });

  // The link table keys on the surface, so a link minted here must say which
  // one it belongs to or it resolves to agent chat and opens nothing.
  it.each(['liftoff', 'insights', 'team_plan'] as const)(
    'mints an agentless %s link',
    async (surface) => {
      await call({ surface });
      expect(findOrCreateLinkMock).toHaveBeenCalledWith({
        tenantId: TENANT,
        destination: 'chat',
        surface,
        agentId: null,
        threadId: THREAD,
        recordId: null,
      });
    },
  );

  it.each([
    ['liftoff', 'Liftoff'],
    ['insights', 'Insights Manager'],
    ['team_plan', 'Chief AI Officer'],
  ] as const)('names %s as the sender', async (surface, speaker) => {
    await call({ surface });
    const payload = enqueueNotificationMock.mock.calls[0][0].payload;
    expect(payload.eventTitle).toBe(speaker);
    expect(payload.internalAgentName).toBe(speaker);
  });

  // Notifying somebody about a message they are watching arrive is noise, and
  // the fastest way to teach them to turn notifications off.
  it.each(['liftoff', 'insights'] as const)(
    'says nothing when the reader is on a %s thread',
    async (surface) => {
      isAccountPresentMock.mockResolvedValue(true);
      await call({ surface });
      expect(isAccountPresentMock).toHaveBeenCalledWith(surface, TENANT, THREAD, ACCOUNT);
      expect(enqueueNotificationMock).not.toHaveBeenCalled();
    },
  );

  // Team-plan seats live in workforce-service's database. Reading this
  // service's presence table for them would always answer "absent", which is
  // not a check — it is a check-shaped no-op. That caller checks before calling.
  it('does not read local presence for the team plan', async () => {
    await call({ surface: 'team_plan' });
    expect(isAccountPresentMock).not.toHaveBeenCalled();
    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
  });

  // Several replies in one thread should replace each other, not stack.
  it('collapses on the thread id', async () => {
    await call();
    expect(enqueueNotificationMock.mock.calls[0][0].payload.threadId).toBe(THREAD);
  });

  // The reply is already committed when this runs, so nothing here may throw
  // back into the turn that produced it.
  it('never throws when minting the link fails', async () => {
    findOrCreateLinkMock.mockRejectedValue(new Error('db gone'));
    await expect(call()).resolves.toBeUndefined();
  });

  it('never throws when the notification itself fails', async () => {
    enqueueNotificationMock.mockRejectedValue(new Error('kill switch exploded'));
    await expect(call()).resolves.toBeUndefined();
  });

  it('never throws when the presence read fails', async () => {
    isAccountPresentMock.mockRejectedValue(new Error('pool exhausted'));
    await expect(call()).resolves.toBeUndefined();
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });
});

// Every reason a notification does not arrive looks the same from outside: the
// person granted permission and nothing happened. The enqueue result names the
// rule that applied, and the caller used to throw it away.
describe('what the logs say afterwards', () => {
  it('records how many devices were reached', async () => {
    enqueueNotificationMock.mockResolvedValue({ pushedDevices: 2, emailed: false });
    await call();
    const line = logInfoMock.mock.calls.find((c) => c[0]?.metric === 'chat.reply_notified');
    expect(line![0]).toMatchObject({ pushedDevices: 2, suppressed: null, surface: 'liftoff' });
  });

  it('records the rule that suppressed it', async () => {
    enqueueNotificationMock.mockResolvedValue({ pushedDevices: 0, suppressed: 'type_off' });
    await call();
    const line = logInfoMock.mock.calls.find((c) => c[0]?.metric === 'chat.reply_notified');
    expect(line![0]).toMatchObject({ pushedDevices: 0, suppressed: 'type_off' });
  });
});
