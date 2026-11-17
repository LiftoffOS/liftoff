// How each surface's rows become the one collected shape, for the part that
// says who wrote a row and who helped: the author is the speaker, the helpers
// are `withHelpFrom`, and nobody is listed twice.

const readTeamChatThreads = jest.fn();
const readTeamChatMessages = jest.fn();
const readLiftoffThreads = jest.fn();
const readLiftoffMessages = jest.fn();
const readInsightsThreads = jest.fn();
const readInsightsMessages = jest.fn();
jest.mock('../queries', () => ({
  readTeamChatThreads: (...a: unknown[]) => readTeamChatThreads(...a),
  readTeamChatMessages: (...a: unknown[]) => readTeamChatMessages(...a),
  readLiftoffThreads: (...a: unknown[]) => readLiftoffThreads(...a),
  readLiftoffMessages: (...a: unknown[]) => readLiftoffMessages(...a),
  readInsightsThreads: (...a: unknown[]) => readInsightsThreads(...a),
  readInsightsMessages: (...a: unknown[]) => readInsightsMessages(...a),
}));
const exportTeamPlanThreads = jest.fn();
const exportTeamPlanMessages = jest.fn();
jest.mock('../../workforce-plans/team-plan-thread-client', () => ({
  exportTeamPlanThreads: (...a: unknown[]) => exportTeamPlanThreads(...a),
  exportTeamPlanMessages: (...a: unknown[]) => exportTeamPlanMessages(...a),
}));

import { ExportBudget } from '../budget';
import {
  collectTeamChat, collectLiftoff, collectInsights, collectChiefAiOfficer, contributorsOf,
} from '../conversations';

const TENANT = '00000000-0000-0000-0000-000000000001';
const AS_OF = new Date('2026-09-19T00:00:00.000Z');
const at = (s: string) => new Date(s);

const thread = { id: 'thread-1', account_id: 'acc-1', channel: 'web', title: 'Contract review', created_at: at('2026-09-01T00:00:00Z'), updated_at: at('2026-09-01T00:05:00Z'), sort_cursor: 'x' };

function teamRow(overrides: Record<string, unknown>) {
  return {
    id: 'm', thread_id: 'thread-1', agent_id: 'agent-1', role: 'assistant', content: 'x', message_type: null,
    attachments: null, media: null, contributors: [], created_at: at('2026-09-01T00:01:00Z'), turn_id: null,
    produced_in_turn_id: null, sender_account_id: null, sender_label: null, sort_cursor: 'x', ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  readTeamChatThreads.mockResolvedValue([thread]);
  readLiftoffThreads.mockResolvedValue([thread]);
  readInsightsThreads.mockResolvedValue([thread]);
});

describe('contributorsOf', () => {
  it('keeps only well-formed entries, in stored order, and reads anything else as nobody', () => {
    expect(contributorsOf([{ id: 'a', label: 'A' }, { id: 'b' }, null, { id: 'c', label: '' }, { id: 'd', label: 'D' }]))
      .toEqual([{ id: 'a', label: 'A' }, { id: 'd', label: 'D' }]);
    expect(contributorsOf(null)).toEqual([]);
    expect(contributorsOf('[]')).toEqual([]);
  });
});

describe('collectTeamChat', () => {
  it('names the team as the speaker of its own reply and its delegates as the helpers', async () => {
    readTeamChatMessages.mockResolvedValue([
      teamRow({ id: 'm1', contributors: [{ id: 'agent-7', label: 'Security Review' }, { id: 'agent-8', label: 'Legal Counsel' }] }),
    ]);
    const [conversation] = await collectTeamChat(TENANT, AS_OF, new ExportBudget());
    expect(conversation.messages[0].speaker).toEqual({ kind: 'team', agentId: 'agent-1' });
    expect(conversation.messages[0].withHelpFrom).toEqual(['Security Review', 'Legal Counsel']);
  });

  it('names the colleague as the speaker of a colleague row, with no helpers', async () => {
    readTeamChatMessages.mockResolvedValue([
      teamRow({ id: 'm2', message_type: 'colleague', contributors: [{ id: 'caio', label: 'Chief AI Officer' }] }),
    ]);
    const [conversation] = await collectTeamChat(TENANT, AS_OF, new ExportBudget());
    expect(conversation.messages[0].speaker).toEqual({ kind: 'named', name: 'Chief AI Officer' });
    expect(conversation.messages[0].withHelpFrom).toEqual([]);
    expect(conversation.messages[0].messageType).toBe('colleague');
  });

  it('falls back to the team for a colleague row with no contributor, and never helps a user row', async () => {
    readTeamChatMessages.mockResolvedValue([
      teamRow({ id: 'm3', message_type: 'colleague', contributors: [] }),
      teamRow({ id: 'm4', role: 'user', agent_id: null, sender_account_id: 'acc-1', contributors: [{ id: 'x', label: 'X' }] }),
    ]);
    const [conversation] = await collectTeamChat(TENANT, AS_OF, new ExportBudget());
    expect(conversation.messages[0].speaker).toEqual({ kind: 'team', agentId: 'agent-1' });
    expect(conversation.messages[1].speaker).toEqual({ kind: 'account', accountId: 'acc-1', label: null });
    expect(conversation.messages[1].withHelpFrom).toEqual([]);
  });
});

describe('the assistant surfaces', () => {
  const assistantRow = (overrides: Record<string, unknown>) => ({
    id: 'm', thread_id: 'thread-1', role: 'assistant', content: 'x', message_type: null, attachments: null,
    media: null, author: null, author_label: null, contributors: [], sender_account_id: null,
    created_at: at('2026-09-01T00:01:00Z'), sort_cursor: 'x', ...overrides,
  });

  it("on Liftoff the author is the whole attribution: From names it and nobody helped", async () => {
    readLiftoffMessages.mockResolvedValue([assistantRow({ author: 'caio', author_label: 'Chief AI Officer' })]);
    const [conversation] = await collectLiftoff(TENANT, AS_OF, new ExportBudget());
    expect(conversation.messages[0].speaker).toEqual({ kind: 'named', name: 'Chief AI Officer' });
    expect(conversation.messages[0].withHelpFrom).toEqual([]);
  });

  it('on the Insights Manager the contributors of its own reply are its helpers', async () => {
    readInsightsMessages.mockResolvedValue([assistantRow({ contributors: [{ id: 'caio', label: 'Chief AI Officer' }] })]);
    const [conversation] = await collectInsights(TENANT, AS_OF, new ExportBudget());
    expect(conversation.messages[0].speaker).toEqual({ kind: 'named', name: 'Insights Manager' });
    expect(conversation.messages[0].withHelpFrom).toEqual(['Chief AI Officer']);
  });

  it('on the Insights Manager a colleague row names the colleague it brought in as the speaker', async () => {
    readInsightsMessages.mockResolvedValue([
      assistantRow({ message_type: 'colleague', contributors: [{ id: 'caio', label: 'Chief AI Officer' }] }),
      assistantRow({ id: 'm2', message_type: 'colleague', contributors: [] }),
    ]);
    const [conversation] = await collectInsights(TENANT, AS_OF, new ExportBudget());
    expect(conversation.messages[0].speaker).toEqual({ kind: 'named', name: 'Chief AI Officer' });
    expect(conversation.messages[0].withHelpFrom).toEqual([]);
    // No contributor to name: the surface's own assistant, as on a team's chat.
    expect(conversation.messages[1].speaker).toEqual({ kind: 'named', name: 'Insights Manager' });
  });
});

describe('the Chief AI Officer', () => {
  const caller = { tenantId: TENANT, accountId: 'acc-1', role: 'owner' as const };
  const caioRow = (overrides: Record<string, unknown>) => ({
    id: 'm', threadId: 'thread-1', role: 'assistant', content: 'x', messageType: null, attachments: null,
    media: null, contributors: [], senderAccountId: null, createdAt: '2026-09-01T00:01:00.000Z', ...overrides,
  });

  beforeEach(() => {
    exportTeamPlanThreads.mockResolvedValue({
      items: [{ id: 'thread-1', accountId: 'acc-1', title: 'Sizing', createdAt: '2026-09-01T00:00:00.000Z' }],
      nextCursor: null,
    });
  });

  it('names a colleague row\'s colleague as the speaker, and its own helpers as helpers', async () => {
    exportTeamPlanMessages.mockResolvedValue({
      items: [
        caioRow({ messageType: 'colleague', contributors: [{ id: 'insights', label: 'Insights Manager' }] }),
        caioRow({ id: 'm2', contributors: [{ id: 'insights', label: 'Insights Manager' }] }),
      ],
      nextCursor: null,
    });
    const [conversation] = await collectChiefAiOfficer(caller, AS_OF, new ExportBudget());
    expect(conversation.messages[0].speaker).toEqual({ kind: 'named', name: 'Insights Manager' });
    expect(conversation.messages[0].withHelpFrom).toEqual([]);
    expect(conversation.messages[1].speaker).toEqual({ kind: 'named', name: 'Chief AI Officer' });
    expect(conversation.messages[1].withHelpFrom).toEqual(['Insights Manager']);
  });
});
