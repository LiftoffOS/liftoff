// Plan v6 Change 8.6 — embed sweeper: keyset-cursor progress past failures,
// exit-code contract, gate-first no-op, drift pass via
// getDefaultEmbeddingSpace, closePools in finally, and the ◆v6 row-level vs
// systemic escalation taxonomy.

const mockInitSecrets = jest.fn();
jest.mock('../../infrastructure/secrets', () => ({
  initSecrets: (...args: unknown[]) => mockInitSecrets(...args),
}));

const mockInitDatabase = jest.fn();
const mockClosePools = jest.fn();
const mockAdminQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  initDatabase: (...args: unknown[]) => mockInitDatabase(...args),
  closePools: (...args: unknown[]) => mockClosePools(...args),
  withAdminScope: jest.fn(async (_opts: unknown, cb: (c: { query: typeof mockAdminQuery }) => unknown) =>
    cb({ query: mockAdminQuery })),
}));

const mockInitEmbeddingClient = jest.fn();
jest.mock('../../embedding/init', () => ({
  initEmbeddingClient: (...args: unknown[]) => mockInitEmbeddingClient(...args),
}));

const mockEmbedTurn = jest.fn();
jest.mock('../../agent-chat/turn-embedding-service', () => ({
  embedTurn: (...args: unknown[]) => mockEmbedTurn(...args),
}));

const mockEmbedPlatformTurn = jest.fn();
jest.mock('../../chat-recall/turn-embedding', () => ({
  embedPlatformTurn: (...args: unknown[]) => mockEmbedPlatformTurn(...args),
}));

const mockGetDefaultEmbeddingSpace = jest.fn();
jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: {
    getDefaultEmbeddingSpace: (...args: unknown[]) => mockGetDefaultEmbeddingSpace(...args),
  },
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ log: mockLog }));

import { main, sweep } from '../embed-sweep-chat-turns';

const ROW = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  tenant_id: '11111111-1111-4111-8111-111111111111',
  created_at: `2026-07-0${n}T00:00:00.000Z`,
});

class ExitError extends Error {
  constructor(public code: number | undefined) { super(`exit ${code}`); }
}

describe('sweep()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDefaultEmbeddingSpace.mockReturnValue({ provider: 'google', model: 'gemini-embedding-001' });
    // The sweep covers one turns table per surface, two passes each. A default
    // of "no rows" means a test can queue batches for the surface it is about
    // and stay silent about the others — and a fourth surface does not rewrite
    // every test here. The mockResolvedValueOnce chains below are consumed in
    // TARGETS order, which puts them on team chat.
    mockAdminQuery.mockResolvedValue({ rows: [] });
  });

  it('sweeps every surface that has turns, both passes each', async () => {
    await sweep();

    const tables = mockAdminQuery.mock.calls
      .map((c) => /FROM (\w+)/.exec(c[0] as string)?.[1])
      .filter((t): t is string => !!t);

    // Each surface's own table, and neither pass skipped: a surface that stops
    // being swept is invisible until somebody notices recall has gone stale.
    for (const table of ['agent_chat_turns', 'liftoff_chat_turns', 'insights_chat_turns']) {
      const passes = mockAdminQuery.mock.calls
        .filter((c) => (c[0] as string).includes(`FROM ${table}`))
        .map((c) => (c[0] as string).includes('content_embedding IS NULL') ? 'unembedded' : 'drift');
      expect(new Set(passes)).toEqual(new Set(['unembedded', 'drift']));
    }
    expect(new Set(tables)).toEqual(
      new Set(['agent_chat_turns', 'liftoff_chat_turns', 'insights_chat_turns']),
    );
  });

  it('advances the keyset cursor past permanently-failing rows (no infinite loop, no false success)', async () => {
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [ROW(1), ROW(2)] })  // pass 1, batch 1
      .mockResolvedValueOnce({ rows: [] })                // pass 1, batch 2 (cursor moved)
      .mockResolvedValueOnce({ rows: [] });               // pass 2 (drift) empty
    mockEmbedTurn
      .mockResolvedValueOnce('failed')     // ROW(1): row-level failure
      .mockResolvedValueOnce('embedded');  // ROW(2)

    const report = await sweep();

    expect(report.embedded).toBe(1);
    expect(report.failed).toBe(1);
    // Second batch query carries the cursor of the LAST row — including the
    // failed one's successor — proving failures don't stall the sweep.
    const secondParams = mockAdminQuery.mock.calls[1][1] as unknown[];
    expect(secondParams[0]).toBe(ROW(2).created_at);
    expect(secondParams[1]).toBe(ROW(2).id);
  });

  it('counts outcome buckets (guest/empty/missing) without failing the run', async () => {
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [ROW(1), ROW(2), ROW(3)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockEmbedTurn
      .mockResolvedValueOnce('skipped_guest')
      .mockResolvedValueOnce('skipped_empty')
      .mockResolvedValueOnce('missing');

    const report = await sweep();
    expect(report.skippedGuest).toBe(1);
    expect(report.skippedEmpty).toBe(1);
    expect(report.failed).toBe(1); // 'missing' counts as failed
    expect(report.embedded).toBe(0);
  });

  it('drift pass re-embeds provider/model mismatches using getDefaultEmbeddingSpace (no probe)', async () => {
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [] })          // pass 1 empty
      .mockResolvedValueOnce({ rows: [ROW(4)] })    // drift batch
      .mockResolvedValueOnce({ rows: [] });         // drift done
    mockEmbedTurn.mockResolvedValueOnce('embedded');

    const report = await sweep();

    expect(report.reembedded).toBe(1);
    expect(report.embedded).toBe(0);
    expect(mockGetDefaultEmbeddingSpace).toHaveBeenCalledTimes(1);
    // Drift predicate receives the current space as $3/$4.
    const driftParams = mockAdminQuery.mock.calls[1][1] as unknown[];
    expect(driftParams[2]).toBe('google');
    expect(driftParams[3]).toBe('gemini-embedding-001');
  });

  it('skips the drift pass for every surface (with one warn) when no default embedding space resolves', async () => {
    mockGetDefaultEmbeddingSpace.mockReturnValue(undefined);

    const report = await sweep();

    expect(report.reembedded).toBe(0);
    // Pass 1 still runs on every surface — it needs no space. Pass 2 runs on
    // none, and the space is resolved ONCE rather than per surface, so the warn
    // is not repeated three times.
    expect(mockAdminQuery).toHaveBeenCalledTimes(3);
    for (const call of mockAdminQuery.mock.calls) {
      expect(call[0] as string).toContain('content_embedding IS NULL');
    }
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      {},
      'embed-sweep: no default embedding space resolved — drift pass skipped for every surface',
    );
  });

  it('a single embedTurn REJECTION is counted and the sweep continues; success resets the counter', async () => {
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [ROW(1), ROW(2), ROW(3), ROW(4)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockEmbedTurn
      .mockRejectedValueOnce(new Error('conn reset'))   // rejection 1
      .mockResolvedValueOnce('embedded')                // resets counter
      .mockRejectedValueOnce(new Error('conn reset'))   // rejection 1 again
      .mockRejectedValueOnce(new Error('conn reset'));  // rejection 2 — still < 3

    const report = await sweep();

    expect(report.embedded).toBe(1);
    expect(report.failed).toBe(3);
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: ROW(1).id }),
      'embed-sweep: embedTurn rejected',
    );
  });

  it('3 CONSECUTIVE rejections escalate as systemic and abort the sweep', async () => {
    mockAdminQuery.mockResolvedValueOnce({ rows: [ROW(1), ROW(2), ROW(3), ROW(4)] });
    mockEmbedTurn.mockRejectedValue(new Error('pool down'));

    await expect(sweep()).rejects.toThrow('systemic: 3 consecutive embedTurn rejections — aborting sweep');
    expect(mockEmbedTurn).toHaveBeenCalledTimes(3); // ROW(4) never attempted
  });

  it('a batch-enumeration throw is systemic by definition and propagates immediately', async () => {
    mockAdminQuery.mockRejectedValueOnce(new Error('db unreachable'));
    await expect(sweep()).rejects.toThrow('db unreachable');
    expect(mockEmbedTurn).not.toHaveBeenCalled();
  });
});

describe('main() — gate + exit-code contract', () => {
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RECALL_EMBED_WRITE_ENABLED;
    mockClosePools.mockResolvedValue(undefined);
    mockGetDefaultEmbeddingSpace.mockReturnValue({ provider: 'google', model: 'gemini-embedding-001' });
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitError(code);
    }) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    delete process.env.RECALL_EMBED_WRITE_ENABLED;
  });

  it('flag off → genuine no-op exit 0: no secrets, no DB, no embedding init', async () => {
    await expect(main()).rejects.toThrow('exit 0');
    expect(mockInitSecrets).not.toHaveBeenCalled();
    expect(mockInitDatabase).not.toHaveBeenCalled();
    expect(mockInitEmbeddingClient).not.toHaveBeenCalled();
    expect(mockAdminQuery).not.toHaveBeenCalled();
  });

  it('all-success run → exit 0, closePools called, report printed', async () => {
    process.env.RECALL_EMBED_WRITE_ENABLED = 'true';
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [ROW(1)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockEmbedTurn.mockResolvedValueOnce('embedded');

    await expect(main()).rejects.toThrow('exit 0');
    expect(mockClosePools).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('"embedded": 1'))).toBe(true);
  });

  it('failed > 0 → exit non-zero', async () => {
    process.env.RECALL_EMBED_WRITE_ENABLED = 'true';
    mockAdminQuery
      .mockResolvedValueOnce({ rows: [ROW(1)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockEmbedTurn.mockResolvedValueOnce('failed');

    await expect(main()).rejects.toThrow('exit 1');
    expect(mockClosePools).toHaveBeenCalledTimes(1);
  });

  it('systemic sweep throw → embed_sweep_systemic_failure logged, closePools still called, exit 1', async () => {
    process.env.RECALL_EMBED_WRITE_ENABLED = 'true';
    mockAdminQuery.mockRejectedValueOnce(new Error('db unreachable'));

    await expect(main()).rejects.toThrow('exit 1');
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'embed_sweep_systemic_failure', error: 'db unreachable' }),
      'embed-sweep: systemic failure — aborting',
    );
    expect(mockClosePools).toHaveBeenCalledTimes(1);
  });
});
