// The boundary rule the CAIO backfill infers turns with.
//
// The turn rows this pass writes are derived, not recorded, so every case the rule
// decides is pinned here — including the ones it deliberately leaves out, because
// "left alone on purpose" and "missed" look identical in the table afterwards.
//
// The same rule and the same cases as the control plane's pass over Liftoff and
// the Insights Manager. Two copies because they are two deployables reading two
// databases; if either rule changes, both suites have to.

jest.mock('../infrastructure/database.js', () => ({
  getPool: jest.fn(),
  initPool: jest.fn(),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { groupIntoTurns } from '../scripts/backfill-team-plan-turns.js';

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

    expect(turns.map((t) => t.messageIds)).toEqual([['u1', 'a1'], ['u2', 'a2']]);
  });

  it('keeps a preamble, a colleague reply and the closing reply in one turn', () => {
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
      const turns = groupIntoTurns([
        row('u1', 'user'),
        row('f1', 'assistant', { type: 'forwarded_context' }),
        row('a1', 'assistant'),
      ]);

      expect(turns).toHaveLength(1);
      expect(turns[0].messageIds).toEqual(['u1', 'a1']);
    });

    it('ignores a typed USER row: it is a browser event, not speech', () => {
      const turns = groupIntoTurns([
        row('b1', 'user', { type: 'browser_handback' }),
        row('u1', 'user'), row('a1', 'assistant'),
      ]);

      expect(turns[0].messageIds).toEqual(['u1', 'a1']);
      expect(turns).toHaveLength(1);
    });

    it('drops a greeting-only thread entirely', () => {
      // On this surface most untitled threads are greeting-only shells the
      // history modal already hides; inventing a turn for one would put it in a
      // search result.
      expect(groupIntoTurns([row('g1', 'assistant'), row('g2', 'assistant')])).toEqual([]);
      expect(groupIntoTurns([])).toEqual([]);
    });

    it('drops the greeting but keeps the exchange that follows it', () => {
      const turns = groupIntoTurns([
        row('g1', 'assistant'),
        row('u1', 'user'), row('a1', 'assistant'),
      ]);

      expect(turns).toHaveLength(1);
      expect(turns[0].messageIds).toEqual(['u1', 'a1']);
    });
  });

  it('a person\'s message with no reply is still a turn', () => {
    expect(groupIntoTurns([row('u1', 'user')])[0].messageIds).toEqual(['u1']);
  });

  it('attributes each turn to whoever spoke it in a workspace-shared thread', () => {
    const turns = groupIntoTurns([
      row('u1', 'user', { sender: 'ada' }), row('a1', 'assistant'),
      row('u2', 'user', { sender: 'grace' }), row('a2', 'assistant'),
    ]);

    expect(turns.map((t) => t.senderAccountId)).toEqual(['ada', 'grace']);
  });

  it('groups a reply that arrived after a second question with the LATER one', () => {
    // The known failure mode, documented rather than fixed: nothing in the data
    // marks a reply that was still running when the next message arrived.
    const turns = groupIntoTurns([
      row('u1', 'user'), row('u2', 'user'), row('a1', 'assistant'),
    ]);

    expect(turns.map((t) => t.messageIds)).toEqual([['u1'], ['u2', 'a1']]);
  });
});
