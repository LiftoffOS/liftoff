// Messages delivered into a CAIO turn that is already running.
//
// The failure modes worth pinning are the ones that make a message vanish
// quietly: delivering into a claim left behind by a crashed instance, two
// boundary polls both answering the same message, and a message written a
// moment after the turn ended sitting in a row nobody will ever read.

const mockQuery = jest.fn();
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: (_tenantId: string, fn: (c: { query: jest.Mock }) => unknown) =>
    fn({ query: mockQuery }),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  claimUserMessage,
  deliverUserMessage,
  findLiveTurnId,
  frameInterrupt,
} from '../workforce-plans/turn-signal-repository.js';

const TENANT = '22222222-2222-2222-2222-222222222222';
const THREAD = '33333333-3333-3333-3333-333333333333';
const TURN = '44444444-4444-4444-4444-444444444444';

function pgError(code: string): Error & { code: string } {
  const err = new Error(`postgres error ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('findLiveTurnId', () => {
  it('ignores a claim old enough to have been stranded by a crash', async () => {
    await findLiveTurnId(TENANT, THREAD);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("started_at > NOW() - INTERVAL '15 minutes'");
  });

  it('reads a failed lookup as an idle thread, never as a conflict', async () => {
    // The worst case then is one extra turn. Reporting "busy" instead would
    // reject a message on the strength of a database blip.
    mockQuery.mockRejectedValue(new Error('pool is on fire'));
    await expect(findLiveTurnId(TENANT, THREAD)).resolves.toBeNull();
  });
});

describe('deliverUserMessage', () => {
  it('writes the message against the turn that must answer it', async () => {
    await expect(
      deliverUserMessage(TENANT, TURN, {
        text: 'actually, make it cheaper',
        senderAccountId: 'account-1',
        senderDisplayName: 'Ada',
      }),
    ).resolves.toBe('delivered');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO team_plan_turn_signals');
    expect(params[0]).toBe(TURN);
    expect(JSON.parse(params[1] as string)).toMatchObject({
      text: 'actually, make it cheaper',
      senderDisplayName: 'Ada',
    });
  });

  it('reports a turn that ended between the lookup and the write', async () => {
    // The foreign key makes the race visible instead of leaving a row nobody
    // reads. The caller answers with a fresh turn.
    mockQuery.mockRejectedValue(pgError('23503'));
    await expect(
      deliverUserMessage(TENANT, TURN, {
        text: 'hi', senderAccountId: null, senderDisplayName: null,
      }),
    ).resolves.toBe('no_turn');
  });

  it('reports the table being absent as unavailable rather than throwing', async () => {
    mockQuery.mockRejectedValue(pgError('42P01'));
    await expect(
      deliverUserMessage(TENANT, TURN, {
        text: 'hi', senderAccountId: null, senderDisplayName: null,
      }),
    ).resolves.toBe('unavailable');
  });
});

describe('claimUserMessage', () => {
  it('claims in the same statement that reads, so two polls cannot both deliver it', async () => {
    mockQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{ payload: { text: 'also check support', senderDisplayName: 'Ada' } }],
    });
    const claimed = await claimUserMessage(TENANT, TURN);
    expect(claimed).toEqual({
      text: 'also check support',
      senderDisplayName: 'Ada',
      senderAccountId: null,
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE team_plan_turn_signals SET consumed_at = NOW\(\)/);
    expect(sql).toContain('consumed_at IS NULL');
    expect(sql).toContain('ORDER BY created_at ASC');
  });

  it('returns nothing when nothing is waiting', async () => {
    await expect(claimUserMessage(TENANT, TURN)).resolves.toBeNull();
  });

  it('reads a failed check as nothing waiting, never as a reason to end the turn', async () => {
    mockQuery.mockRejectedValue(new Error('pool is on fire'));
    await expect(claimUserMessage(TENANT, TURN)).resolves.toBeNull();
  });
});

describe('frameInterrupt', () => {
  it('attributes the sender and says the task continues', () => {
    const framed = frameInterrupt({
      text: 'make it cheaper',
      senderDisplayName: 'Ada',
      senderAccountId: 'account-1',
    });
    expect(framed).toContain('Ada just sent a message while you were working');
    expect(framed).toContain('"make it cheaper"');
    expect(framed).toContain('This is a mid-run addition to the current task, not a new task.');
  });

  it('falls back to anonymous wording rather than inventing a sender', () => {
    const framed = frameInterrupt({ text: 'stop that', senderDisplayName: null, senderAccountId: null });
    expect(framed).toContain('A user message arrived while you were working');
  });
});
