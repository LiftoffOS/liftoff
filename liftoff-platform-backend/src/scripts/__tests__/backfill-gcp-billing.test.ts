// The loop's stop conditions are the whole risk surface.
//
// The ingester returns {ingested:0, skipped:0} when it is up to date, when the
// table is missing, and when a day genuinely had no cost — three different
// situations behind one value. A loop that reads the COUNT to decide when to
// stop either spins to MAX_DAYS or halts on the first quiet day. These pin that
// it reads the CURSOR instead.

const getCursorMock = jest.fn();
const updateCursorMock = jest.fn();
const runIngesterMock = jest.fn();

jest.mock('../../cost-attribution/repository', () => ({
  getCursor: getCursorMock,
  updateCursor: updateCursorMock,
}));

jest.mock('../../cost-attribution/ingestion/gcp-billing-ingester', () => ({
  runGcpBillingIngester: runIngesterMock,
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const DAY = 86_400_000;

/** Cursor that advances one day each time the ingester is called. */
function advancingCursor(startIso: string): void {
  let ts = new Date(`${startIso}T23:59:59Z`).getTime();
  getCursorMock.mockImplementation(async () => ({ lastTs: new Date(ts), lastId: null }));
  runIngesterMock.mockImplementation(async () => {
    ts += DAY;
    return { ingested: 3, skipped: 0 };
  });
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('gcp billing backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FROM_DATE = '2026-03-01';
    delete process.env.DRY_RUN;
    delete process.env.MAX_DAYS;
    updateCursorMock.mockResolvedValue(undefined);
  });

  it('requires FROM_DATE', async () => {
    delete process.env.FROM_DATE;
    const { runGcpBillingBackfill } = await import('../backfill-gcp-billing');
    await expect(runGcpBillingBackfill()).rejects.toThrow('FROM_DATE');
  });

  it('rewinds the cursor to the day before FROM_DATE', async () => {
    // The ingester derives its day from the cursor, so this is how a range is
    // chosen. Off by one here silently skips the first day of the range.
    process.env.FROM_DATE = '2026-03-01';
    process.env.MAX_DAYS = '1';
    advancingCursor('2026-08-01');
    const { runGcpBillingBackfill } = await import('../backfill-gcp-billing');
    await runGcpBillingBackfill();
    const written = updateCursorMock.mock.calls[0][1] as Date;
    expect(written.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('will NOT skip days forward without an explicit opt-in', async () => {
    // The cursor only ever moves forward afterwards, so a day skipped here is
    // never ingested by this or any later run — the exact silent gap this
    // script exists to repair. Default behaviour is to resume from the cursor.
    process.env.FROM_DATE = '2026-08-08';
    process.env.MAX_DAYS = '1';
    delete process.env.ALLOW_CURSOR_ADVANCE;
    advancingCursor('2026-03-22'); // well behind FROM_DATE
    const { runGcpBillingBackfill } = await import('../backfill-gcp-billing');
    await runGcpBillingBackfill();
    expect(updateCursorMock).not.toHaveBeenCalled();
  });

  it('skips forward when ALLOW_CURSOR_ADVANCE is set, and says what it abandoned', async () => {
    process.env.FROM_DATE = '2026-08-08';
    process.env.MAX_DAYS = '1';
    process.env.ALLOW_CURSOR_ADVANCE = '1';
    advancingCursor('2026-03-22');
    const { runGcpBillingBackfill } = await import('../backfill-gcp-billing');
    await runGcpBillingBackfill();
    const written = updateCursorMock.mock.calls[0][1] as Date;
    expect(written.toISOString().slice(0, 10)).toBe('2026-08-07');
    delete process.env.ALLOW_CURSOR_ADVANCE;
  });

  it('stops when the cursor stalls rather than spinning to MAX_DAYS', async () => {
    process.env.MAX_DAYS = '500';
    const frozen = new Date('2026-03-05T23:59:59Z');
    getCursorMock.mockResolvedValue({ lastTs: frozen, lastId: null });
    runIngesterMock.mockResolvedValue({ ingested: 0, skipped: 0 });
    const { runGcpBillingBackfill } = await import('../backfill-gcp-billing');
    const out = await runGcpBillingBackfill();
    expect(out.stoppedBecause).toBe('cursor-stalled');
    expect(runIngesterMock).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when the table is missing', async () => {
    process.env.MAX_DAYS = '500';
    getCursorMock.mockResolvedValue({ lastTs: new Date('2026-03-05T23:59:59Z'), lastId: null });
    runIngesterMock.mockResolvedValue({ ingested: 0, skipped: 0, tableMissing: true });
    const { runGcpBillingBackfill } = await import('../backfill-gcp-billing');
    const out = await runGcpBillingBackfill();
    expect(out.stoppedBecause).toBe('table-missing');
    expect(runIngesterMock).toHaveBeenCalledTimes(1);
  });

  it('keeps going through days that ingest nothing', async () => {
    // A day with no GCP cost is normal and must not end the backfill — the
    // count is not the signal, the cursor is.
    process.env.MAX_DAYS = '5';
    let ts = new Date('2026-03-01T23:59:59Z').getTime();
    getCursorMock.mockImplementation(async () => ({ lastTs: new Date(ts), lastId: null }));
    runIngesterMock.mockImplementation(async () => {
      ts += DAY;
      return { ingested: 0, skipped: 0 };
    });
    const { runGcpBillingBackfill } = await import('../backfill-gcp-billing');
    const out = await runGcpBillingBackfill();
    expect(out.daysProcessed).toBe(5);
    expect(out.stoppedBecause).toBe('max-days');
  });

  it('stops once the cursor reaches yesterday', async () => {
    process.env.FROM_DATE = isoDaysAgo(3);
    process.env.MAX_DAYS = '50';
    advancingCursor(isoDaysAgo(3));
    const { runGcpBillingBackfill } = await import('../backfill-gcp-billing');
    const out = await runGcpBillingBackfill();
    expect(out.stoppedBecause).toBe('caught-up');
  });

  it('DRY_RUN writes nothing at all', async () => {
    process.env.DRY_RUN = '1';
    getCursorMock.mockResolvedValue({ lastTs: null, lastId: null });
    const { runGcpBillingBackfill } = await import('../backfill-gcp-billing');
    const out = await runGcpBillingBackfill();
    expect(out.stoppedBecause).toBe('dry-run');
    expect(updateCursorMock).not.toHaveBeenCalled();
    expect(runIngesterMock).not.toHaveBeenCalled();
  });
});
