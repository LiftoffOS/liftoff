// A 1:1 Teams chat belongs to the USER and the BOT, not to an agent.
//
// There is one Liftoff Teams app, so one personal conversation per person —
// `agent_teams_conversations.conversation_id` is UNIQUE for exactly that
// reason. The `agent_id` column records who last spoke there, which is
// chat-routing state.
//
// `postReviewCardFanout` addressed assignees through
// `listConversationsForAgent(tenantId, agentId)`, so a proactive review card
// could only reach someone whose most recent Teams interaction happened to
// involve the agent now asking for approval. Every newly created agent began
// life unable to reach anybody, no matter how many people had installed the bot.
//
// An assignee whose personal conversation is bound to other agents looks
// unreachable: the asking agent looks up its own agent id, finds nothing, and
// records "no teams conversation reference" — for a person sitting in a chat
// with the very bot that needs to reach them, with `last_success_at` never
// set, while Slack delivers to the same person every time: Slack resolves by
// email and opens a DM, with no agent in the lookup.

import {
  listPersonalConversationsByAccount,
  listConversationsForAgent,
  findPersonalConversationByUser,
  bindConversationAgent,
} from '../repository';

jest.mock('../../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_t: string, fn: (c: unknown) => unknown) =>
    fn({ query: mockQuery })),
  getPool: jest.fn(() => ({ query: mockQuery })),
}));

const mockQuery = jest.fn();

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const AGENT = '122662dd-de4e-4b0d-8873-50cd6a00daaf';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
});

/** The WHERE clause alone. `agent_id` legitimately appears in ORDER BY as a
 *  preference, so a whole-statement grep cannot tell a filter from a sort. */
function whereClause(sql: string): string {
  const from = sql.indexOf('WHERE');
  const to = sql.indexOf('ORDER BY');
  return sql.slice(from, to === -1 ? undefined : to);
}

describe('listPersonalConversationsByAccount', () => {
  it('treats the agent as a PREFERENCE, never as a filter', async () => {
    // The whole point: the agent that last spoke in a chat must not decide
    // whether a different agent can reach that person. It may decide which
    // thread is preferred when there is a choice.
    await listPersonalConversationsByAccount(TENANT, AGENT);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(whereClause(sql)).not.toContain('agent_id');
    expect(sql).toContain('(agent_id = $2) DESC NULLS LAST');
    expect(mockQuery.mock.calls[0][1]).toEqual([TENANT, AGENT]);
  });

  it('restricts to personal scope with a resolved account', async () => {
    // A channel or group conversation is not a DM, and a row with no
    // account_id cannot be matched to an assignee.
    await listPersonalConversationsByAccount(TENANT, AGENT);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("scope = 'personal'");
    expect(sql).toContain('account_id IS NOT NULL');
  });

  it('returns newest first, so a stale reference loses to a fresh one', async () => {
    await listPersonalConversationsByAccount(TENANT, AGENT);
    // Recency breaks the tie once the agent preference has been applied.
    expect(String(mockQuery.mock.calls[0][0])).toContain('updated_at DESC');
  });

  it('is tenant-scoped like every other read on this table', async () => {
    await listPersonalConversationsByAccount(TENANT, AGENT);
    expect(String(mockQuery.mock.calls[0][0])).toContain('tenant_id = $1');
  });

  it('maps the account id and the reference the fan-out needs', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        conversation_id: 'conv-1',
        account_id: 'b9594e6f-3855-4d12-8b49-d5004ee4a0f6',
        conversation_reference: { serviceUrl: 'https://smba.example', bot: { id: 'b' } },
      }],
    });
    const rows = await listPersonalConversationsByAccount(TENANT, AGENT);
    expect(rows).toEqual([{
      accountId: 'b9594e6f-3855-4d12-8b49-d5004ee4a0f6',
      conversationId: 'conv-1',
      conversationReference: { serviceUrl: 'https://smba.example', bot: { id: 'b' } },
    }]);
  });
});

describe('the agent-scoped lookup is left alone', () => {
  it('still filters on agent_id, because chat routing legitimately needs that', async () => {
    // This query answers "which conversations is this agent currently in",
    // which is what the chat surface wants and what an unbound row is correctly
    // excluded from.
    await listConversationsForAgent(TENANT, AGENT);
    expect(String(mockQuery.mock.calls[0][0])).toContain('agent_id = $2');
  });
});

describe('findPersonalConversationByUser had the same defect', () => {
  it('prefers the asking agent but reaches the person regardless', async () => {
    // teams_send_dm could only reach someone whose personal conversation
    // happened to be bound to the sending agent; every other agent was told the
    // person had no Teams chat at all.
    await findPersonalConversationByUser(TENANT, AGENT, 'aad-user-1');
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(whereClause(sql)).not.toContain('agent_id');
    expect(sql).toContain('(agent_id = $2) DESC NULLS LAST');
    expect(sql).toContain("scope = 'personal'");
  });
});

describe('a conversation may exist before an agent is picked', () => {
  it('accepts a null agent and never clears an existing binding', async () => {
    // The install-time write: the chat is real, nobody has picked an agent yet.
    // Re-running it on a conversation somebody is already using must not unbind
    // them, which is what a bare `agent_id = $2` would have done.
    await bindConversationAgent({
      tenantId: TENANT,
      agentId: null,
      conversationId: 'conv-new',
      azureAdTenantId: 'aad-tenant',
      scope: 'personal',
      aadUserId: 'aad-user-1',
      accountId: 'b9594e6f-3855-4d12-8b49-d5004ee4a0f6',
      conversationReference: { serviceUrl: 'https://smba.example' },
    });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // The colleague columns change only on a real pick; the install-time write
    // says it picked nothing and leaves both as they were.
    expect(sql).toContain('agent_id = CASE WHEN $12 THEN $2 ELSE agent_teams_conversations.agent_id END');
    expect(sql).toContain('assistant_kind = CASE WHEN $12 THEN $3 ELSE agent_teams_conversations.assistant_kind END');
    expect(params[1]).toBeNull();
    expect(params[2]).toBeNull();
    expect(params[11]).toBe(false);
  });

  it('binds a platform assistant in its own column and calls it a pick', async () => {
    await bindConversationAgent({
      tenantId: TENANT,
      agentId: 'caio',
      conversationId: 'conv-new',
      azureAdTenantId: 'aad-tenant',
      scope: 'personal',
      aadUserId: 'aad-user-1',
      accountId: 'b9594e6f-3855-4d12-8b49-d5004ee4a0f6',
      conversationReference: { serviceUrl: 'https://smba.example' },
    });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[1]).toBeNull();
    expect(params[2]).toBe('caio');
    expect(params[11]).toBe(true);
  });
});
