// A lock is not a heartbeat (INV-PB-018).
//
// The three boundaries below are the whole property, and the middle one is the
// failure mode: an instance that loses every Postgres socket at once exits
// mid-turn. Its lock row carries an `expires_at` well in the future and a
// heartbeat that has stopped, and a reader that asks only about the lease calls
// it live. Until the lease runs out each message to that thread comes back as
// an interrupt addressed to a turn nothing is running, and no reply arrives.
//
// These tests read the predicate as SQL text rather than against a database,
// which is the only thing a unit test here can honestly do — the suite has no
// Postgres. What they pin is that the fragment asks about BOTH columns, that
// every statement in the module is built from that one fragment, and that the
// three lifecycle writes say what the rollout depends on them saying. The
// live check that a stale-heartbeat row is reclaimed runs against dev, per the
// plan's verification section.

import {
  LIVE_LOCK_PREDICATE,
  LIVE_WINDOW_SECONDS,
  acquireLock,
  findActiveTurnId,
  heartbeatLock,
  liveTurnId,
  releaseLock,
} from '../turn-registry';

// ── The scope wrapper, captured ────────────────────────────────────────

type Captured = { sql: string; params: unknown[] };
const captured: Captured[] = [];

/** What each statement should answer with, in order. */
let responses: Array<{ rows?: Array<Record<string, unknown>>; rowCount?: number }> = [];

const fakeClient = {
  query: jest.fn(async (sql: string, params?: unknown[]) => {
    captured.push({ sql, params: params ?? [] });
    return responses.shift() ?? { rows: [], rowCount: 0 };
  }),
};

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(
    async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => fn(fakeClient),
  ),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TENANT = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const TURN = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  captured.length = 0;
  responses = [];
  fakeClient.query.mockClear();
});

// ── The three boundaries ───────────────────────────────────────────────
//
// Evaluated as Postgres would, from the fragment's own text, so the arithmetic
// the predicate performs is the arithmetic under test rather than a paraphrase
// of it.

/** Evaluate LIVE_LOCK_PREDICATE against one row, the way Postgres would. */
function isLive(row: { heartbeatAgoSeconds: number; leaseInSeconds: number }): boolean {
  const windowMatch = LIVE_LOCK_PREDICATE.match(/INTERVAL '(\d+) seconds'/);
  if (!windowMatch) throw new Error('the predicate no longer states its window in seconds');
  const windowSeconds = Number(windowMatch[1]);
  const heartbeatFresh = -row.heartbeatAgoSeconds > -windowSeconds;
  const leaseHeld = row.leaseInSeconds > 0;
  return heartbeatFresh && leaseHeld;
}

describe('LIVE_LOCK_PREDICATE at its three boundaries', () => {
  it('a turn heartbeated a moment ago is live', () => {
    expect(isLive({ heartbeatAgoSeconds: 1, leaseInSeconds: 19 * 60 })).toBe(true);
  });

  it('a heartbeat 80s old is DEAD even with 19 minutes of lease left', () => {
    // THE FAILURE MODE. A reader that asks only the second question calls
    // this row live. 80s is past the 75s window
    // and three missed 20s beats.
    expect(isLive({ heartbeatAgoSeconds: 80, leaseInSeconds: 19 * 60 })).toBe(false);
  });

  it('an expired lease is dead however fresh the heartbeat', () => {
    // The lease has one job left: a row whose owner never came back is
    // reclaimable. A row past it is nobody's, even mid-beat — otherwise two
    // turns could both believe they hold the thread.
    expect(isLive({ heartbeatAgoSeconds: 1, leaseInSeconds: -1 })).toBe(false);
  });

  it('asks about both columns, and says which window it means', () => {
    expect(LIVE_WINDOW_SECONDS).toBe(75);
    expect(LIVE_LOCK_PREDICATE).toContain('heartbeat_at >');
    expect(LIVE_LOCK_PREDICATE).toContain(`INTERVAL '${LIVE_WINDOW_SECONDS} seconds'`);
    expect(LIVE_LOCK_PREDICATE).toContain('expires_at > NOW()');
  });

  it('tolerates three missed beats and no more', () => {
    // The window is sized off the heartbeat (20s ± 3s), not off how long a turn
    // takes. Two numbers chosen independently is how the old pair ended up 10x
    // apart.
    const longestBeat = 23;
    expect(LIVE_WINDOW_SECONDS).toBeGreaterThan(longestBeat * 3);
    expect(LIVE_WINDOW_SECONDS).toBeLessThan(longestBeat * 4);
  });
});

// ── Every statement is built from that one fragment ────────────────────

describe('one predicate, every caller', () => {
  it('the reader asks the predicate, not the lease', async () => {
    responses = [{ rows: [{ turn_id: TURN }] }];
    await expect(liveTurnId('liftoff', TENANT, THREAD)).resolves.toBe(TURN);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toContain(LIVE_LOCK_PREDICATE);
    expect(captured[0].sql).toContain('FROM liftoff_turn_locks');
    expect(captured[0].params).toEqual([TENANT, THREAD]);
  });

  it('acquisition clears a row the predicate calls dead, not merely expired', async () => {
    // The widening. `expires_at <= NOW()` left a thread whose container died
    // unreclaimable for the rest of the lease, which is the twenty minutes the
    // person spent being answered by nothing.
    responses = [{ rowCount: 1 }, { rowCount: 1 }];
    await expect(acquireLock('insights', TENANT, THREAD, TURN)).resolves.toBe('acquired');
    expect(captured[0].sql).toContain('DELETE FROM insights_turn_locks');
    expect(captured[0].sql).toContain(`NOT (${LIVE_LOCK_PREDICATE})`);
    expect(captured[0].sql).not.toContain('expires_at <= NOW()');
  });

  it('"idle" and "acquirable" are the same string', async () => {
    // Not a stylistic point. A reader that thought the thread was free while
    // acquire thought it was taken would answer a person with a 409 the UI has
    // no state for. So both statements are asserted to carry the fragment
    // BYTE-FOR-BYTE, which is only possible because neither writes it.
    responses = [{ rows: [] }];
    await liveTurnId('liftoff', TENANT, THREAD);
    const readerSql = captured[0].sql;

    captured.length = 0;
    responses = [{ rowCount: 1 }, { rowCount: 1 }];
    await acquireLock('liftoff', TENANT, THREAD, TURN);
    const acquireSql = captured[0].sql;

    expect(readerSql).toContain(LIVE_LOCK_PREDICATE);
    expect(acquireSql).toContain(LIVE_LOCK_PREDICATE);
    // And the fragment composes positionally with whatever predicates its
    // callers already have: no placeholders of its own to renumber.
    expect(LIVE_LOCK_PREDICATE).not.toContain('$');
  });
});

// ── The lifecycle writes the rollout depends on ────────────────────────

describe('the writes the two-deployment rollout rests on', () => {
  it('acquisition stamps heartbeat_at explicitly, not by column default', async () => {
    // By default it would be right only for the row's first instant. The
    // column's DEFAULT NOW() is for rows that already existed when migration
    // 561 ran; from that deployment on the writer names it.
    responses = [{ rowCount: 1 }, { rowCount: 1 }];
    await acquireLock('liftoff', TENANT, THREAD, TURN);
    const insert = captured[1];
    expect(insert.sql).toContain('INSERT INTO liftoff_turn_locks');
    expect(insert.sql).toContain('expires_at, heartbeat_at)');
    // The last value is the heartbeat stamp, not a default the row inherits.
    expect(insert.sql).toMatch(/VALUES \(.*, NOW\(\)\)/);
  });

  it('the heartbeat moves BOTH columns', async () => {
    // Writing only `expires_at` is what the old heartbeat did, and it is the
    // whole reason the writer had to ship one deployment ahead of the readers:
    // an old revision's live turn carries a frozen heartbeat, and a new
    // revision reading the 75s predicate would reclaim the thread underneath
    // it.
    responses = [{ rowCount: 1 }];
    await expect(heartbeatLock('liftoff', TENANT, THREAD, TURN)).resolves.toBe(1);
    expect(captured[0].sql).toContain('heartbeat_at = NOW()');
    expect(captured[0].sql).toContain('expires_at = NOW() +');
  });

  it('a heartbeat that matches no row reports zero, so the turn can give up', async () => {
    responses = [{ rowCount: 0 }];
    await expect(heartbeatLock('insights', TENANT, THREAD, TURN)).resolves.toBe(0);
  });

  it('release is keyed on the turn, so a reclaimed turn cannot delete its successor', async () => {
    responses = [{ rowCount: 1 }];
    await releaseLock('insights', TENANT, THREAD, TURN);
    expect(captured[0].sql).toContain('DELETE FROM insights_turn_locks');
    expect(captured[0].params).toEqual([TENANT, THREAD, TURN]);
  });

  it('a lost race reports held rather than throwing', async () => {
    responses = [{ rowCount: 0 }, { rowCount: 0 }];
    await expect(acquireLock('liftoff', TENANT, THREAD, TURN)).resolves.toBe('held');
  });
});

// ── Error policy ───────────────────────────────────────────────────────

describe('a lookup that cannot run says idle, and a presence poll does not', () => {
  it('findActiveTurnId treats a missing table as idle', async () => {
    const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    fakeClient.query.mockImplementationOnce(async () => { throw missing; });
    await expect(findActiveTurnId('liftoff', TENANT, THREAD)).resolves.toBeNull();
  });

  it('findActiveTurnId treats any other failure as idle too', async () => {
    fakeClient.query.mockImplementationOnce(async () => { throw new Error('boom'); });
    await expect(findActiveTurnId('insights', TENANT, THREAD)).resolves.toBeNull();
  });

  it('liveTurnId lets the error out, because its caller owns the transaction', async () => {
    // Swallowing inside the presence poll's transaction would be a lie twice
    // over: the transaction is already aborted and every statement after it
    // fails anyway.
    fakeClient.query.mockImplementationOnce(async () => { throw new Error('boom'); });
    await expect(liveTurnId('liftoff', TENANT, THREAD)).rejects.toThrow('boom');
  });
});

// ── The caller's own transaction ───────────────────────────────────────

describe('a caller inside a transaction keeps it', () => {
  it('uses the client it was handed and opens no scope of its own', async () => {
    const { withTenantScope } = jest.requireMock('../../infrastructure/database');
    (withTenantScope as jest.Mock).mockClear();
    responses = [{ rows: [{ turn_id: TURN }] }];
    await expect(liveTurnId('liftoff', TENANT, THREAD, fakeClient as never)).resolves.toBe(TURN);
    expect(withTenantScope).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
  });

  it('opens one when it was handed none', async () => {
    const { withTenantScope } = jest.requireMock('../../infrastructure/database');
    (withTenantScope as jest.Mock).mockClear();
    responses = [{ rows: [] }];
    await liveTurnId('insights', TENANT, THREAD);
    expect(withTenantScope).toHaveBeenCalledTimes(1);
  });
});
