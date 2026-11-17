// Contributors on team-plan messages (migration 028).
//
// The same column, under the same name and shape, as platform-backend's
// agent_chat_messages.contributors, so one frontend renderer draws the
// attribution chips on every surface. Nothing on this surface writes it
// today; these pin that the read path is end-to-end regardless — a listed
// message carries the list, an inserted one writes it (as [] for nobody, never
// NULL), and a row read without the column reads as nobody.

const mockQuery = jest.fn();
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: (_tenantId: string, fn: (c: { query: jest.Mock }) => unknown) =>
    fn({ query: mockQuery }),
}));

import { appendMessage, listMessages } from '../workforce-plans/chat-repository.js';

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_MEMBER = '00000000-0000-0000-0000-000000000020';
const THREAD_ID = '00000000-0000-0000-0000-000000000100';

const CONTRIBUTORS = [{ id: 'insights', label: 'Insights Manager' }];

function makeMessageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000200',
    thread_id: THREAD_ID,
    role: 'assistant',
    content: 'Here is the team I propose.',
    visualization_blocks: null,
    attachments: null,
    media: null,
    contributors: [],
    message_type: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: new Date('2026-09-05T12:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset();
});

describe('team-plan messages / contributors', () => {
  it('writes the empty list, never NULL, when nobody else had a hand in the row', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      role: 'assistant',
      content: 'Here is the team I propose.',
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Addressed by NAME, not by position. Both of the assertions here used to be
    // positional — a column-order regex and `$13` — and migration 031's turn_id
    // moved both. The position is a fact the statement already states.
    const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
    expect(columns).toContain('contributors');
    expect(params).toHaveLength(columns.length);
    expect(params[columns.indexOf('contributors')]).toBe('[]');
    expect(message.contributors).toEqual([]);
  });

  it('writes the list when given, and reads it back on the message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ contributors: CONTRIBUTORS })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const message = await appendMessage({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      role: 'assistant',
      content: 'The Insights Manager says costs are up 4%.',
      contributors: CONTRIBUTORS,
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[11]).toBe(JSON.stringify(CONTRIBUTORS));
    expect(message.contributors).toEqual(CONTRIBUTORS);
  });

  it('leaves the sender column where it was: a user row still names its sender at $11', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [makeMessageRow({ role: 'user', content: 'Plan me a support pod.' })] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await appendMessage({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      role: 'user',
      senderAccountId: ACCOUNT_MEMBER,
      content: 'Plan me a support pod.',
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[10]).toBe(ACCOUNT_MEMBER);
    expect(params[11]).toBe('[]');
  });

  it('selects the column in listMessages and maps a row without it as nobody', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        makeMessageRow({ id: 'm-reply', contributors: CONTRIBUTORS }),
        makeMessageRow({ id: 'm-old', contributors: null }),
      ],
    });

    const page = await listMessages(THREAD_ID, TENANT_A);

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/SELECT[\s\S]*\bcontributors\b[\s\S]*FROM team_plan_messages/);
    expect(page.messages.map((m) => m.contributors)).toEqual([CONTRIBUTORS, []]);
  });
});
