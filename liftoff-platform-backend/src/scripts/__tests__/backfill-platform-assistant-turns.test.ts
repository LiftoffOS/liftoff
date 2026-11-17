// The boundary rule the backfill infers turns with.
//
// This is the whole risk of the pass: the turn rows it writes are derived, not
// recorded, so every case the rule decides is pinned here — including the ones it
// deliberately leaves out, because "left alone on purpose" and "missed" look
// identical in the table afterwards.

jest.mock('../../infrastructure/database', () => ({
  closePools: jest.fn(),
  initDatabase: jest.fn(),
  withAdminScope: jest.fn(),
  withTenantScope: jest.fn(),
}));
jest.mock('../../infrastructure/secrets', () => ({ initSecrets: jest.fn() }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { groupIntoTurns } from '../backfill-platform-assistant-turns';

type Row = {
  id: string;
  role: string;
  message_type: string | null;
  sender_account_id: string | null;
  created_at: string;
};

let clock = 0;
function row(id: string, role: string, opts: { type?: string; sender?: string } = {}): Row {
  clock += 1;
  return {
    id,
    role,
    message_type: opts.type ?? null,
    sender_account_id: opts.sender ?? (role === 'user' ? 'acct-1' : null),
    created_at: new Date(Date.UTC(2026, 8, 1, 0, clock, 0)).toISOString(),
  };
}

beforeEach(() => { clock = 0; });

describe('the boundary rule', () => {
  it('groups an alternating transcript into one turn per exchange', () => {
    const turns = groupIntoTurns([
      row('u1', 'user'), row('a1', 'assistant'),
      row('u2', 'user'), row('a2', 'assistant'),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].messageIds).toEqual(['u1', 'a1']);
    expect(turns[1].messageIds).toEqual(['u2', 'a2']);
  });

  it('keeps several assistant rows of one exchange together', () => {
    // A preamble, a colleague's reply and the closing reply are all one turn.
    const turns = groupIntoTurns([
      row('u1', 'user'), row('a1', 'assistant'), row('a2', 'assistant'), row('a3', 'assistant'),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].messageIds).toEqual(['u1', 'a1', 'a2', 'a3']);
  });

  it('takes the turn\'s owner and time from the person\'s row, not the reply', () => {
    const rows = [row('u1', 'user', { sender: 'acct-9' }), row('a1', 'assistant')];
    const turns = groupIntoTurns(rows);

    expect(turns[0].senderAccountId).toBe('acct-9');
    expect(turns[0].createdAt).toBe(rows[0].created_at);
  });

  describe('what it leaves out, and must', () => {
    it('never puts narration in a turn, and does not let it break one', () => {
      // A status line between a question and its answer: the two stay together,
      // and the status line joins neither.
      const turns = groupIntoTurns([
        row('u1', 'user'),
        row('s1', 'assistant', { type: 'hitl_status' }),
        row('a1', 'assistant'),
      ]);

      expect(turns).toHaveLength(1);
      expect(turns[0].messageIds).toEqual(['u1', 'a1']);
    });

    it('ignores a typed USER row too: it is a browser event, not speech', () => {
      const turns = groupIntoTurns([
        row('b1', 'user', { type: 'browser_handback' }),
        row('u1', 'user'),
        row('a1', 'assistant'),
      ]);

      expect(turns).toHaveLength(1);
      expect(turns[0].messageIds).toEqual(['u1', 'a1']);
    });

    it('drops a greeting: rows before the first person\'s message join no turn', () => {
      // Inventing a turn for these would put words in a search result that
      // nobody said to anybody.
      const turns = groupIntoTurns([
        row('g1', 'assistant'), row('g2', 'assistant'),
        row('u1', 'user'), row('a1', 'assistant'),
      ]);

      expect(turns).toHaveLength(1);
      expect(turns[0].messageIds).toEqual(['u1', 'a1']);
    });

    it('returns nothing for a thread nobody ever spoke in', () => {
      expect(groupIntoTurns([row('g1', 'assistant')])).toEqual([]);
      expect(groupIntoTurns([])).toEqual([]);
    });
  });

  it('a person\'s message with no reply is still a turn', () => {
    // A failed or abandoned turn is recallable: they said it, and asking about it
    // later is exactly when recall matters.
    const turns = groupIntoTurns([row('u1', 'user')]);

    expect(turns).toHaveLength(1);
    expect(turns[0].messageIds).toEqual(['u1']);
  });

  it('attributes each turn to whoever spoke it in a shared thread', () => {
    const turns = groupIntoTurns([
      row('u1', 'user', { sender: 'ada' }), row('a1', 'assistant'),
      row('u2', 'user', { sender: 'grace' }), row('a2', 'assistant'),
    ]);

    expect(turns.map((t) => t.senderAccountId)).toEqual(['ada', 'grace']);
  });

  describe('the known failure mode', () => {
    it('groups a reply that arrived after a second question with the LATER one', () => {
      // Documented rather than fixed: nothing in the data marks a reply that was
      // still running when the next message arrived. The mis-pairing stays inside
      // one conversation, seconds apart, which is why the pass is still worth
      // more than leaving the history unsearchable.
      const turns = groupIntoTurns([
        row('u1', 'user'),
        row('u2', 'user'),
        row('a1', 'assistant'), // in truth the answer to u1
      ]);

      expect(turns[0].messageIds).toEqual(['u1']);
      expect(turns[1].messageIds).toEqual(['u2', 'a1']);
    });
  });
});
