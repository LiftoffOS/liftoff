// The lock-and-signal layer behind insights mid-run control (ADR-041).
//
// The lock row IS the in-flight registry, so these tests pin the three
// properties the rest of the design leans on: a signal is claimed exactly once,
// a missing table degrades open instead of taking chat down, and a signal never
// outlives the turn it was addressed to.

const mockPoolQuery = jest.fn();
const mockWithTenantScope = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockPoolQuery(...args) }),
  withTenantScope: (...args: unknown[]) => mockWithTenantScope(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import {
  claimAbortSignal,
  claimUserMessageSignal,
  findActiveTurnId,
  frameInterrupt,
  insertTurnSignal,
  releaseAllLiveTurnLocks,
  releaseTurnLock,
  tryAcquireTurnLock,
  tryInsertAbortSignal,
  TurnLockUnavailableError,
  type TurnLockHandle,
} from '../turn-control';
import { LIVE_LOCK_PREDICATE } from '../../common/turn-registry';

const TENANT_ID = 'tenant-1';
const THREAD_ID = 'thread-1';
const TURN_ID = 'turn-1';

interface QueryCall { sql: string; params: unknown[] }

/** Run scoped callbacks against a fake client whose query() is scripted. */
function useScopedClient(query: jest.Mock): QueryCall[] {
  const calls: QueryCall[] = [];
  mockWithTenantScope.mockImplementation(
    async (_tenantId: string, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
      const client = {
        query: jest.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return query(sql, params);
        }),
      };
      return await fn(client);
    },
  );
  return calls;
}

function relationMissing(): Error & { code: string } {
  const err = new Error('relation "insights_turn_locks" does not exist') as Error & { code: string };
  err.code = '42P01';
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolQuery.mockResolvedValue({ rowCount: 0, rows: [] });
});

describe('tryAcquireTurnLock', () => {
  it('returns a handle when the insert wins the thread', async () => {
    useScopedClient(jest.fn(async (sql: string) => ({ rowCount: sql.includes('INSERT') ? 1 : 0 })));
    const lock = await tryAcquireTurnLock(TENANT_ID, THREAD_ID, TURN_ID);
    expect(lock).not.toBeNull();
    expect(lock!.turnId).toBe(TURN_ID);
    await releaseTurnLock(lock!);
  });

  it('returns null when another turn already holds the thread', async () => {
    useScopedClient(jest.fn(async () => ({ rowCount: 0 })));
    await expect(tryAcquireTurnLock(TENANT_ID, THREAD_ID, TURN_ID)).resolves.toBeNull();
  });

  it('degrades open when the table is missing rather than failing the turn', async () => {
    mockWithTenantScope.mockRejectedValue(relationMissing());
    const lock = await tryAcquireTurnLock(TENANT_ID, THREAD_ID, TURN_ID);
    expect(lock).not.toBeNull();
    expect(lock!.heartbeatTask).toBeNull();
    await releaseTurnLock(lock!);
  });

  it('surfaces any other database failure as TurnLockUnavailableError', async () => {
    mockWithTenantScope.mockRejectedValue(new Error('connection terminated'));
    await expect(tryAcquireTurnLock(TENANT_ID, THREAD_ID, TURN_ID)).rejects.toBeInstanceOf(
      TurnLockUnavailableError,
    );
  });
});

describe('releaseTurnLock', () => {
  it('drops the lock row and lets the cascade take the signals with it', async () => {
    // No sweep to write and none to forget: insights_turn_signals.turn_id is a
    // foreign key onto the lock, ON DELETE CASCADE.
    const handle: TurnLockHandle = {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      abortController: new AbortController(),
      heartbeatTask: null,
      consecutiveFailures: 0,
      released: false,
    };
    const scoped = useScopedClient(jest.fn(async () => ({ rowCount: 1 })));

    await releaseTurnLock(handle);

    expect(scoped).toHaveLength(1);
    expect(scoped[0].sql).toContain('DELETE FROM insights_turn_locks');
    expect(handle.released).toBe(true);
  });

  it('retries a failed release rather than leaving the thread looking busy', async () => {
    // A row left behind means the next message is delivered into a turn that is
    // not running, and nothing ever answers it.
    const handle: TurnLockHandle = {
      tenantId: TENANT_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      abortController: new AbortController(),
      heartbeatTask: null,
      consecutiveFailures: 0,
      released: false,
    };
    let attempts = 0;
    const scoped = useScopedClient(
      jest.fn(async () => {
        attempts++;
        if (attempts === 1) throw new Error('connection terminated');
        return { rowCount: 1 };
      }),
    );

    await releaseTurnLock(handle);

    expect(scoped).toHaveLength(2);
  });
});

describe('releaseAllLiveTurnLocks', () => {
  it('hands back the locks this instance still holds', async () => {
    // The SIGTERM handler calls this: a deploy must not leave threads busy for
    // the whole expiry window.
    useScopedClient(jest.fn(async (sql: string) => ({ rowCount: sql.includes('INSERT') ? 1 : 0 })));
    const lock = await tryAcquireTurnLock(TENANT_ID, THREAD_ID, TURN_ID);
    expect(lock).not.toBeNull();

    const scoped = useScopedClient(jest.fn(async () => ({ rowCount: 1 })));
    await releaseAllLiveTurnLocks();

    expect(scoped.some(c => c.sql.includes('DELETE FROM insights_turn_locks'))).toBe(true);
    expect(lock!.released).toBe(true);

    // Nothing left to release on a second drain.
    const second = useScopedClient(jest.fn(async () => ({ rowCount: 1 })));
    await releaseAllLiveTurnLocks();
    expect(second).toHaveLength(0);
  });
});

describe('findActiveTurnId', () => {
  it('asks whether anything is heartbeating, not just whether the lease holds', async () => {
    // This assertion used to read `expires_at > NOW()`, which is the negation of
    // what its own name claimed — a lease is pushed out every time it is
    // written, so a row abandoned 19 minutes ago and one heartbeated a second
    // ago looked identical. The predicate is the registry's now (INV-PB-018).
    const calls = useScopedClient(jest.fn(async () => ({ rows: [] })));
    await expect(findActiveTurnId(TENANT_ID, THREAD_ID)).resolves.toBeNull();
    expect(calls[0].sql).toContain(LIVE_LOCK_PREDICATE);
  });

  it('treats a missing table as an idle thread', async () => {
    mockWithTenantScope.mockRejectedValue(relationMissing());
    await expect(findActiveTurnId(TENANT_ID, THREAD_ID)).resolves.toBeNull();
  });
});

describe('signal claims', () => {
  it('claims an abort exactly once across two concurrent polls', async () => {
    // Consumption IS the claim: the UPDATE ... RETURNING means the loser of the
    // race sees zero rows rather than re-consuming the same signal.
    let remaining = 1;
    useScopedClient(
      jest.fn(async () => {
        if (remaining > 0) {
          remaining--;
          return { rowCount: 1, rows: [{ id: 'signal-1' }] };
        }
        return { rowCount: 0, rows: [] };
      }),
    );
    const [a, b] = await Promise.all([
      claimAbortSignal(TENANT_ID, TURN_ID),
      claimAbortSignal(TENANT_ID, TURN_ID),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('claims a user message with a single atomic statement, inside a tenant scope', async () => {
    // The signals policy resolves tenancy through the lock, so every read and
    // write has to carry the tenant context — the same shape the Chief AI
    // Officer chat uses for its own signals table.
    const calls = useScopedClient(
      jest.fn(async () => ({
        rowCount: 1,
        rows: [{ payload: { text: 'break it down by team', senderDisplayName: 'Ada' } }],
      })),
    );
    const claimed = await claimUserMessageSignal(TENANT_ID, TURN_ID);
    expect(claimed).toEqual({
      text: 'break it down by team',
      senderDisplayName: 'Ada',
      senderAccountId: null,
    });
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/UPDATE insights_turn_signals SET consumed_at = NOW\(\)/);
    expect(calls[0].sql).toContain('consumed_at IS NULL');
  });

  it('returns nothing when the signals table is missing', async () => {
    mockWithTenantScope.mockRejectedValue(relationMissing());
    await expect(claimAbortSignal(TENANT_ID, TURN_ID)).resolves.toBe(false);
    await expect(claimUserMessageSignal(TENANT_ID, TURN_ID)).resolves.toBeNull();
    await expect(
      insertTurnSignal(TENANT_ID, TURN_ID, 'user_message', { text: 'hi' }),
    ).resolves.toBe('unavailable');
  });
});

describe('insertTurnSignal', () => {
  it('reports a turn that ended between the lookup and the write', async () => {
    // The foreign key makes the race visible instead of writing a row nobody
    // will ever read. The caller starts a fresh turn rather than 409-ing.
    const violation = new Error('insert violates foreign key constraint') as Error & { code: string };
    violation.code = '23503';
    mockWithTenantScope.mockRejectedValue(violation);
    await expect(
      insertTurnSignal(TENANT_ID, TURN_ID, 'user_message', { text: 'hi' }),
    ).resolves.toBe('no_turn');
  });

  it('reports a delivered signal', async () => {
    useScopedClient(jest.fn(async () => ({ rowCount: 1 })));
    await expect(
      insertTurnSignal(TENANT_ID, TURN_ID, 'user_message', { text: 'hi' }),
    ).resolves.toBe('delivered');
  });
});

describe('tryInsertAbortSignal', () => {
  it('reports nothing delivered when no turn is running', async () => {
    useScopedClient(jest.fn(async () => ({ rows: [] })));
    await expect(
      tryInsertAbortSignal({
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        senderAccountId: 'account-1',
        senderDisplayName: null,
      }),
    ).resolves.toBe(false);
  });

  it('writes an abort addressed to the live turn', async () => {
    const calls = useScopedClient(
      jest.fn(async (sql: string) => {
        if (sql.includes('SELECT turn_id')) return { rows: [{ turn_id: 'turn-9' }] };
        return { rowCount: 1 };
      }),
    );
    await expect(
      tryInsertAbortSignal({
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        senderAccountId: 'account-1',
        senderDisplayName: 'Ada',
      }),
    ).resolves.toBe(true);
    const insert = calls.find(c => c.sql.includes('INSERT INTO insights_turn_signals'));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe('turn-9');
    expect(insert!.params[1]).toBe('abort');
  });

  it('reports nothing delivered when the turn ended before the abort landed', async () => {
    const violation = new Error('insert violates foreign key constraint') as Error & { code: string };
    violation.code = '23503';
    let firstCall = true;
    mockWithTenantScope.mockImplementation(
      async (_tenantId: string, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
        if (firstCall) {
          firstCall = false;
          return await fn({ query: jest.fn(async () => ({ rows: [{ turn_id: 'turn-9' }] })) } as never);
        }
        throw violation;
      },
    );
    await expect(
      tryInsertAbortSignal({
        tenantId: TENANT_ID,
        threadId: THREAD_ID,
        senderAccountId: 'account-1',
        senderDisplayName: null,
      }),
    ).resolves.toBe(false);
  });
});

describe('frameInterrupt', () => {
  it('attributes the sender and says the task continues', () => {
    const framed = frameInterrupt({
      text: 'break it down by team',
      senderDisplayName: 'Ada',
      senderAccountId: 'account-1',
    });
    expect(framed).toContain('Ada just sent a message while you were working');
    expect(framed).toContain('"break it down by team"');
    expect(framed).toContain('This is a mid-run addition to the current task, not a new task.');
  });

  it('falls back to anonymous wording rather than inventing a sender', () => {
    const framed = frameInterrupt({ text: 'stop that', senderDisplayName: null, senderAccountId: null });
    expect(framed).toContain('A user message arrived while you were working');
  });
});
