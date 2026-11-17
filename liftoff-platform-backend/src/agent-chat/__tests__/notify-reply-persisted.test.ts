// Notifying the person that a reply landed.
//
// This is the ordinary case — somebody asks, the agent answers — and it was
// the one case push did not cover. pushOutOfTurnMessage only ever ran for
// messages written OUTSIDE a turn (a learning confirmation, a routine
// proposal), so a normal reply reached the transcript and nothing else. The
// feature looked complete and could not fire for the thing it was built for.

const mockClientQuery = jest.fn();
const stubClient = { query: mockClientQuery };
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: typeof stubClient) => Promise<unknown>) => fn(stubClient),
}));

const enqueueNotificationMock = jest.fn();
jest.mock('../../notifications', () => ({
  enqueueNotification: (...a: unknown[]) => enqueueNotificationMock(...a),
}));

const findOrCreateLinkMock = jest.fn();
jest.mock('../../notification-links', () => ({
  findOrCreateLink: (...a: unknown[]) => findOrCreateLinkMock(...a),
}));

const isAccountPresentMock = jest.fn();
jest.mock('../presence-repository', () => ({
  isAccountPresent: (...a: unknown[]) => isAccountPresentMock(...a),
}));

import { notifyReplyPersisted } from '../out-of-turn-delivery';

const TENANT = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const AGENT = '33333333-3333-3333-3333-333333333333';
const ACCOUNT = '44444444-4444-4444-4444-444444444444';
const ORIGINAL_URL = process.env.FRONTEND_URL;

function threadRow(channel: string) {
  return { rows: [{ channel, account_id: ACCOUNT }] };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FRONTEND_URL = 'https://example.com';
  isAccountPresentMock.mockResolvedValue(false);
  findOrCreateLinkMock.mockResolvedValue('link-1');
  enqueueNotificationMock.mockResolvedValue({ pushedDevices: 1, emailed: false });
  mockClientQuery.mockResolvedValue(threadRow('web'));
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = ORIGINAL_URL;
});

describe('notifyReplyPersisted', () => {
  it('notifies the thread owner when a reply lands on a web thread', async () => {
    await notifyReplyPersisted({ tenantId: TENANT, threadId: THREAD, agentId: AGENT, text: 'Done.' });

    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
    const arg = enqueueNotificationMock.mock.calls[0][0];
    expect(arg.accountId).toBe(ACCOUNT);
    expect(arg.type).toBe('task_update');
  });

  // Internal ids must not travel in a URL. The link is opaque and resolves
  // server-side.
  it('carries an opaque link, not the thread id', async () => {
    await notifyReplyPersisted({ tenantId: TENANT, threadId: THREAD, agentId: AGENT, text: 'Done.' });
    const link = enqueueNotificationMock.mock.calls[0][0].payload.eventLink as string;
    expect(link).toBe('https://example.com/notification/link-1');
    expect(link).not.toContain(THREAD);
    expect(link).not.toContain(AGENT);
  });

  // Notifying somebody about a message they are watching arrive is noise, and
  // the fastest way to teach them to turn notifications off.
  it('says nothing when the reader is on the thread', async () => {
    isAccountPresentMock.mockResolvedValue(true);
    await notifyReplyPersisted({ tenantId: TENANT, threadId: THREAD, agentId: AGENT, text: 'Done.' });
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });

  // Slack and Teams deliver into their own surface. A browser notification
  // about a Slack reply is a second interruption for something already said.
  it.each(['slack', 'teams', 'mcp'])('stays out of the way on a %s thread', async (channel) => {
    mockClientQuery.mockResolvedValue(threadRow(channel));
    await notifyReplyPersisted({ tenantId: TENANT, threadId: THREAD, agentId: AGENT, text: 'Done.' });
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });

  it('does nothing for a thread that no longer exists', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    await notifyReplyPersisted({ tenantId: TENANT, threadId: THREAD, agentId: AGENT, text: 'Done.' });
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });

  // The reply is already committed when this runs, so nothing here may throw
  // back into the turn that produced it.
  it('never throws when the lookup fails', async () => {
    mockClientQuery.mockRejectedValue(new Error('db gone'));
    await expect(
      notifyReplyPersisted({ tenantId: TENANT, threadId: THREAD, agentId: AGENT, text: 'Done.' }),
    ).resolves.toBeUndefined();
  });

  it('never throws when the notification itself fails', async () => {
    enqueueNotificationMock.mockRejectedValue(new Error('kill switch exploded'));
    await expect(
      notifyReplyPersisted({ tenantId: TENANT, threadId: THREAD, agentId: AGENT, text: 'Done.' }),
    ).resolves.toBeUndefined();
  });
});
