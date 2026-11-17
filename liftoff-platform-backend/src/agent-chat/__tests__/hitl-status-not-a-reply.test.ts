/**
 * A gate's own narration must not mark a thread unread.
 *
 * `hitl_status` rows are written with role 'assistant' so they render in the
 * transcript, but nobody said anything: "Waiting on Ada to approve before
 * continuing", "Approved by Ada". Two writers produce them, and both fire at
 * moments when the reader is the cause:
 *
 *   - chat-service, when a gate pauses the turn
 *   - internal-agent-oversight, when somebody approves or rejects from
 *     /dashboard/review
 *
 * The second is the one that bit: approve in the review queue, and the decision
 * message posted by that click stamped last_agent_message_at, so the team came
 * back marked unread over the reader's own action. A dot that appears because
 * you handled something teaches people to ignore dots.
 *
 * These assert on the statements appendMessage issues, because the property is
 * about which UPDATE runs, and with what.
 */
const queryMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => queryMock(...a) }),
  withTenantScope: async (_t: string, fn: (c: unknown) => unknown) =>
    fn({ query: (...a: unknown[]) => queryMock(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { appendMessage, appendStatusRowOnce, createTurnWithoutUserMessage } from '../chat-repository';
import { BROWSER_HANDBACK_MESSAGE_TYPE, BROWSER_POINT_MESSAGE_TYPE, HITL_STATUS_MESSAGE_TYPE } from '../hitl-status-message';
import { RUN_PROGRESS_MESSAGE_TYPE, RUN_FAILED_MESSAGE_TYPE } from '../run-progress';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/INSERT INTO agent_chat_messages/i.test(sql)) {
      return { rows: [{ id: 'm1', tenant_id: 't', thread_id: 'th', role: 'assistant',
        content: 'x', created_at: new Date() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
});

/** The thread touch statement, and whether it stamped the reply clock. */
function threadTouch(): { sql: string; stampsClock: boolean } {
  const call = queryMock.mock.calls.find(
    c => typeof c[0] === 'string' && /UPDATE agent_chat_threads/i.test(c[0] as string),
  );
  if (!call) throw new Error('appendMessage did not touch the thread at all');
  const sql = call[0] as string;
  return { sql, stampsClock: /last_agent_message_at/.test(sql) };
}

describe('the reply clock', () => {
  it('is stamped by a real team reply', async () => {
    await appendMessage('t', 'th', 'assistant', 'Here is the report you asked for.', 'a');

    expect(threadTouch().stampsClock).toBe(true);
  });

  it('is NOT stamped by a gate decision posted from the review queue', async () => {
    // Exactly what postDecisionToThread writes on approve/reject.
    await appendMessage(
      't', 'th', 'assistant', 'Approved by Ada Lovelace.', 'a',
      null, 0, 0, HITL_STATUS_MESSAGE_TYPE,
    );

    expect(threadTouch().stampsClock).toBe(false);
  });

  it('is NOT stamped by the waiting notice a pause posts', async () => {
    await appendMessage(
      't', 'th', 'assistant', 'Waiting on Ada Lovelace to approve before continuing.', 'a',
      null, 0, 0, HITL_STATUS_MESSAGE_TYPE,
    );

    expect(threadTouch().stampsClock).toBe(false);
  });

  it('is NOT stamped by either row a run writes about itself', async () => {
    // A turn that ends "this hit its time limit at step 8 of 16" has told the
    // reader something true and useful, and has NOT answered them. Stamping the
    // clock would clear the unread dot on a question that is still open.
    //
    // BOTH types: the comment beside the check already reasoned about "a run's
    // progress or its failure", while the code tested only the progress type —
    // so a distinct terminal type would have stamped the clock.
    for (const messageType of [RUN_PROGRESS_MESSAGE_TYPE, RUN_FAILED_MESSAGE_TYPE]) {
      queryMock.mockClear();
      await appendMessage(
        't', 'th', 'assistant', 'This run stopped on an error before it could answer.', 'a',
        null, 0, 0, messageType,
      );
      expect(threadTouch().stampsClock).toBe(false);
    }
  });

  it('is not stamped by anything the person themselves sent', async () => {
    await appendMessage('t', 'th', 'user', 'Please run the report.', null);

    expect(threadTouch().stampsClock).toBe(false);
  });

  it('still bubbles a status row to the top of the list', async () => {
    // Not stamping the reply clock is not the same as pretending nothing
    // happened: the thread still moved, so it still sorts as recently active.
    await appendMessage(
      't', 'th', 'assistant', 'Approved by Ada Lovelace.', 'a',
      null, 0, 0, HITL_STATUS_MESSAGE_TYPE,
    );

    expect(threadTouch().sql).toContain('updated_at = NOW()');
  });
});

describe("the person's browser events", () => {
  it('a hand-back or a point row never stamps the reply clock: the person acted, and the team has not spoken', async () => {
    for (const messageType of [BROWSER_HANDBACK_MESSAGE_TYPE, BROWSER_POINT_MESSAGE_TYPE]) {
      queryMock.mockClear();
      await appendMessage('t', 'th', 'assistant', 'Ada Lovelace handed the browser back', 'a', null, 0, 0, messageType);
      expect(threadTouch().stampsClock).toBe(false);
    }
  });

  it('appendStatusRowOnce inserts under the key with ON CONFLICT DO NOTHING, and a replay writes nothing and touches nothing', async () => {
    const HOLD = '44444444-4444-4444-8444-444444444444';
    const row = await appendStatusRowOnce('t', 'th', 'Ada Lovelace handed the browser back', BROWSER_HANDBACK_MESSAGE_TYPE, `browser_handback:${HOLD}`);
    expect(row?.id).toBe('m1');
    const insert = queryMock.mock.calls.find((c) => /INSERT INTO agent_chat_messages/i.test(c[0] as string))!;
    const sql = (insert[0] as string).replace(/\s+/g, ' ');
    expect(sql).toContain("ON CONFLICT (tenant_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING");
    expect(sql).toContain("'assistant'");
    expect(insert[1]).toEqual(['t', 'th', 'Ada Lovelace handed the browser back', BROWSER_HANDBACK_MESSAGE_TYPE, `browser_handback:${HOLD}`]);
    expect(threadTouch().stampsClock).toBe(false);
    // The replay: the index swallows the insert, nothing comes back, and the
    // thread is not bumped a second time.
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await appendStatusRowOnce('t', 'th', 'Ada Lovelace handed the browser back', BROWSER_HANDBACK_MESSAGE_TYPE, `browser_handback:${HOLD}`)).toBeNull();
    expect(queryMock.mock.calls.some((c) => /UPDATE agent_chat_threads/i.test(c[0] as string))).toBe(false);
  });

  it('createTurnWithoutUserMessage writes the turn row alone, idempotent on the turn id', async () => {
    await createTurnWithoutUserMessage('t', 'th', 'a', 'turn-1', 'acc-1', 'Ada', null);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = (queryMock.mock.calls[0][0] as string).replace(/\s+/g, ' ');
    expect(sql).toContain('INSERT INTO agent_chat_turns');
    expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
    expect(sql).not.toContain('agent_chat_messages');
    // The label is kept only when it is doing work: a resolved account carries the name.
    expect(queryMock.mock.calls[0][1]).toEqual(['turn-1', 't', 'th', 'a', 'acc-1', null, null]);
  });
});
