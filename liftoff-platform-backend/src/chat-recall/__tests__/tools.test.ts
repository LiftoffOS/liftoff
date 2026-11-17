// The dispatcher's two refusals, and the rule that decides them.
//
// The context comes from the authenticated turn, never from the model: a thread
// id in a tool argument would name a conversation the model is not in, and an
// account id there would search another person's words. What is pinned here is
// that the dispatcher does not fill either in from the arguments, and that it
// refuses in words rather than searching the wrong thing.

const mockReadThreadHistory = jest.fn();
jest.mock('../read-thread-history', () => ({
  readThreadHistory: (...a: unknown[]) => mockReadThreadHistory(...a),
}));

const mockRecallConversations = jest.fn();
jest.mock('../recall-conversations', () => ({
  recallConversations: (...a: unknown[]) => mockRecallConversations(...a),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  READ_CONVERSATION_HISTORY_TOOL,
  RECALL_CONVERSATIONS_TOOL,
  chatRecallTools,
  isChatRecallTool,
  runChatRecallTool,
} from '../tools';

beforeEach(() => {
  jest.clearAllMocks();
  mockReadThreadHistory.mockResolvedValue('a transcript');
  mockRecallConversations.mockResolvedValue('some conversations');
});

describe('the tool pair', () => {
  it('offers both, and recognises only them', () => {
    expect(chatRecallTools.map((t) => t.name)).toEqual([
      READ_CONVERSATION_HISTORY_TOOL,
      RECALL_CONVERSATIONS_TOOL,
    ]);
    expect(isChatRecallTool(READ_CONVERSATION_HISTORY_TOOL)).toBe(true);
    expect(isChatRecallTool('dataset_query')).toBe(false);
  });

  it('each description names the other and says which question it answers', () => {
    const [read, recall] = chatRecallTools;
    expect(read.description).toContain('THIS conversation');
    expect(read.description).toContain(RECALL_CONVERSATIONS_TOOL);
    expect(recall.description).toContain('OTHER conversations');
    expect(recall.description).toContain(READ_CONVERSATION_HISTORY_TOOL);
  });

  it('uses the product\'s own words: an internal agent is an agent, never an agent', () => {
    for (const tool of chatRecallTools) {
      expect(tool.description).not.toMatch(/\bagents?\b/i);
      const params = JSON.stringify(tool.input_schema);
      expect(params).not.toMatch(/\bagents?\b/i);
    }
  });
});

describe('the thread read', () => {
  it('reads the turn\'s thread, whatever the model asked for', async () => {
    await runChatRecallTool('ten-1', READ_CONVERSATION_HISTORY_TOOL, { threadId: 'someone-elses' }, {
      surface: 'liftoff',
      threadId: 'the-turns-thread',
      accountId: 'acct-1',
    });

    expect(mockReadThreadHistory).toHaveBeenCalledWith(
      { tenantId: 'ten-1', surface: 'liftoff', threadId: 'the-turns-thread' },
      {},
    );
  });

  it('passes match, limit and before through', async () => {
    await runChatRecallTool('ten-1', READ_CONVERSATION_HISTORY_TOOL,
      { match: 'deadline', limit: 10, before: '2026-09-01T00:00:00Z' },
      { surface: 'insights', threadId: 'thr-1' });

    expect(mockReadThreadHistory.mock.calls[0][1]).toEqual({
      match: 'deadline', limit: 10, before: '2026-09-01T00:00:00Z',
    });
  });
});

describe('the recall search', () => {
  it('searches this surface for the turn\'s person, excluding the executing turn', async () => {
    await runChatRecallTool('ten-1', RECALL_CONVERSATIONS_TOOL, { query: 'deadline' }, {
      surface: 'liftoff',
      threadId: 'thr-1',
      accountId: 'acct-1',
      turnId: 'turn-now',
    });

    expect(mockRecallConversations).toHaveBeenCalledWith(
      { surface: 'liftoff', tenantId: 'ten-1', accountId: 'acct-1', excludeTurnId: 'turn-now' },
      { query: 'deadline' },
    );
  });

  it('refuses on team chat rather than searching the wrong tables', async () => {
    // Team chat reaches its own recall through the runtime's gateway tool,
    // against agent_chat_turns and scoped to the agent that answered.
    const out = await runChatRecallTool('ten-1', RECALL_CONVERSATIONS_TOOL, {}, {
      surface: 'team',
      threadId: 'thr-1',
      accountId: 'acct-1',
    });

    expect(mockRecallConversations).not.toHaveBeenCalled();
    expect(out).toContain('not available on this surface');
  });

  it('refuses when the turn carries no account: there is nobody to scope it to', async () => {
    const out = await runChatRecallTool('ten-1', RECALL_CONVERSATIONS_TOOL, {}, {
      surface: 'liftoff',
      threadId: 'thr-1',
    });

    expect(mockRecallConversations).not.toHaveBeenCalled();
    expect(out).toContain('who is asking');
  });

  it('never takes the account from the model\'s arguments', async () => {
    await runChatRecallTool('ten-1', RECALL_CONVERSATIONS_TOOL, { accountId: 'someone-else' }, {
      surface: 'liftoff',
      threadId: 'thr-1',
      accountId: 'acct-1',
    });

    expect(mockRecallConversations.mock.calls[0][0].accountId).toBe('acct-1');
    expect(mockRecallConversations.mock.calls[0][1]).toEqual({});
  });
});

describe('failure', () => {
  it('answers in words rather than throwing, so nothing is invented for the person', async () => {
    mockReadThreadHistory.mockRejectedValue(new Error('pool is down'));

    const out = await runChatRecallTool('ten-1', READ_CONVERSATION_HISTORY_TOOL, {}, {
      surface: 'liftoff',
      threadId: 'thr-1',
    });

    expect(out).toContain('could not be read');
  });
});
