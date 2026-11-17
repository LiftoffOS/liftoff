// A conversation with an assistant holds together across messages whatever
// the conversation is bound to: the thread is keyed by the conversation and
// the assistant, the first message's thread wins, and the reverse lookup
// answers where a message written between turns should go.

const query = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_tenantId: string, fn: (c: { query: typeof query }) => unknown) => fn({ query }),
}));

import {
  conversationForAssistantThread,
  rememberAssistantThread,
  rememberedAssistantThread,
} from '../assistant-conversation-threads';

const TENANT = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  query.mockReset();
});

it('keys a Slack DM by workspace, channel and thread root, empty for the DM itself', async () => {
  query.mockResolvedValueOnce({ rows: [{ assistant_thread_id: 'th-1' }] });
  const id = await rememberedAssistantThread(TENANT, { surface: 'slack', slackTeamId: 'T1', channelId: 'D1', threadRootTs: null }, 'caio');
  expect(id).toBe('th-1');
  expect(query.mock.calls[0][1]).toEqual([TENANT, 'slack', 'T1:D1:', 'caio']);
});

it('keys a Teams chat by its conversation id and answers null on the first message', async () => {
  query.mockResolvedValueOnce({ rows: [] });
  const id = await rememberedAssistantThread(TENANT, { surface: 'teams', conversationId: 'conv-9' }, 'insights');
  expect(id).toBeNull();
  expect(query.mock.calls[0][1]).toEqual([TENANT, 'teams', 'conv-9', 'insights']);
});

it('remembers the first thread and lets a row already there win', async () => {
  query.mockResolvedValueOnce({ rows: [] });
  await rememberAssistantThread(TENANT, { surface: 'slack', slackTeamId: 'T1', channelId: 'D1', threadRootTs: '17.5' }, 'liftoff', 'th-2');
  expect(query.mock.calls[0][0]).toMatch(/ON CONFLICT .* DO NOTHING/s);
  expect(query.mock.calls[0][1]).toEqual([TENANT, 'slack', 'T1:D1:17.5', 'liftoff', 'th-2']);
});

it('finds the Slack conversation a thread lives in', async () => {
  query.mockResolvedValueOnce({ rows: [{ surface: 'slack', conversation_key: 'T1:D1:', assistant_kind: 'caio' }] });
  expect(await conversationForAssistantThread(TENANT, 'th-1')).toEqual({
    kind: 'caio',
    conversation: { surface: 'slack', slackTeamId: 'T1', channelId: 'D1', threadRootTs: null },
  });
});

it('finds the Teams chat a thread lives in, and nothing for a dashboard thread', async () => {
  query.mockResolvedValueOnce({ rows: [{ surface: 'teams', conversation_key: '19:abc@thread.v2', assistant_kind: 'liftoff' }] });
  expect(await conversationForAssistantThread(TENANT, 'th-3')).toEqual({
    kind: 'liftoff',
    conversation: { surface: 'teams', conversationId: '19:abc@thread.v2' },
  });
  query.mockResolvedValueOnce({ rows: [] });
  expect(await conversationForAssistantThread(TENANT, 'th-4')).toBeNull();
});
