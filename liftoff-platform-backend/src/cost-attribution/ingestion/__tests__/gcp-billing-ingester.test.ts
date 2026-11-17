// One property: which BigQuery failures are treated as "no table" and swallowed.
//
// This is the exact seam that hid six months of GCP cost. The old predicate
// matched any message containing "not found", logged it at INFO as "billing
// export table not yet populated — skipping", and returned success. The
// configured table name had a typo, BigQuery said "Not found: Table …" every
// night, and the job reported a clean run while $16,563.89 of spend never
// entered attribution.
//
// Widening this predicate again — or lowering the log level — restores that
// silence, so the narrowing is what these tests pin.

const bqQueryMock = jest.fn();
const getCursorMock = jest.fn();
const updateCursorMock = jest.fn();
const insertEventsMock = jest.fn();
const ingesterPoolQueryMock = jest.fn();
const logError = jest.fn();

jest.mock('../../../infrastructure/bigquery-client', () => ({
  getBigQueryClient: () => ({ query: bqQueryMock }),
}));

jest.mock('../../repository', () => ({
  getCursor: getCursorMock,
  updateCursor: updateCursorMock,
  insertEvents: insertEventsMock,
  resolveAccountIdForTenant: jest.fn().mockResolvedValue('acct-1'),
  ingestEventWithBuckets: jest.fn().mockResolvedValue(1),
  getIngesterPool: () => ({ query: ingesterPoolQueryMock }),
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: logError, debug: jest.fn() },
}));

describe('gcp billing ingester: missing table vs failing query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GCP_BILLING_SHARED_BQ_DATASET = 'proj.dataset.table_v1_AA_BB_CC';
    getCursorMock.mockResolvedValue({ lastTs: new Date('2026-03-01T23:59:59Z'), lastId: null });
    updateCursorMock.mockResolvedValue(undefined);
    insertEventsMock.mockResolvedValue(1);
    ingesterPoolQueryMock.mockResolvedValue({ rows: [{ count: '0' }] });
  });

  // A successful day, which is the path that had never once executed in
  // production: the BigQuery read always failed first, so nothing downstream of
  // it was ever exercised — including a query that could not run at all.
  describe('a day that actually returns data', () => {
    beforeEach(() => {
      bqQueryMock
        // Query A: tenant-labelled rows
        .mockResolvedValueOnce([[{
          tenant_id: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
          gcp_service: 'BigQuery', cost_usd: 2.5, usage_date: '2026-03-02',
        }]])
        // Query B: unlabelled platform overhead
        .mockResolvedValueOnce([[{ gcp_service: 'Cloud Run', cost_usd: 7.5 }]]);
    });

    it('never touches an RLS table through the unscoped ingester pool', async () => {
      // The crash. cost_attribution_events is RLS-FORCED, so counting the
      // platform row through getIngesterPool() raised "unrecognized
      // configuration parameter app.current_tenant_id" and killed the run.
      // insertEvents already reports what it wrote; nothing needs re-reading.
      const { runGcpBillingIngester } = await import('../gcp-billing-ingester');
      await runGcpBillingIngester();
      expect(ingesterPoolQueryMock).not.toHaveBeenCalled();
    });

    it('counts the platform row from what was written, not from a table scan', async () => {
      // A COUNT over the table cannot tell a row written by THIS run from one
      // an earlier run of the same date wrote, so a re-run reported ingesting a
      // day on which it inserted nothing.
      insertEventsMock.mockResolvedValue(0); // conflict: the row already existed
      const { runGcpBillingIngester } = await import('../gcp-billing-ingester');
      const out = await runGcpBillingIngester();
      expect(out.ingested).toBe(1); // the tenant row only, not the platform row
    });

    it('advances the cursor once the day is written', async () => {
      const { runGcpBillingIngester } = await import('../gcp-billing-ingester');
      await runGcpBillingIngester();
      expect(updateCursorMock).toHaveBeenCalled();
    });
  });

  describe('a tenant-id label that is not a tenant id', () => {
    // Every labelled resource in the estate carries `tenant-id: liftoffos` — a
    // name, not a UUID. Passing it to a uuid column threw `invalid input syntax
    // for type uuid` and killed the day mid-backfill.
    beforeEach(() => {
      bqQueryMock
        .mockResolvedValueOnce([[{
          tenant_id: 'liftoffos', gcp_service: 'Cloud SQL', cost_usd: 4, usage_date: '2026-03-23',
        }]])
        .mockResolvedValueOnce([[{ gcp_service: 'Cloud Run', cost_usd: 6 }]]);
    });

    it('does not hand a non-UUID label to the tenant lookup', async () => {
      const repo = await import('../../repository');
      const { runGcpBillingIngester } = await import('../gcp-billing-ingester');
      await runGcpBillingIngester();
      expect(repo.resolveAccountIdForTenant).not.toHaveBeenCalled();
    });

    it('records the cost as platform overhead rather than dropping it', async () => {
      // Query B excludes it (the row HAS a tenant-id label) and the tenant path
      // cannot use it, so without folding it in the cost belongs to neither and
      // silently vanishes — the exact loss this ingester was fixed to stop.
      const { runGcpBillingIngester } = await import('../gcp-billing-ingester');
      await runGcpBillingIngester();
      const written = insertEventsMock.mock.calls[0][0] as Array<{ costUsd: number; source: string }>;
      expect(written[0].source).toBe('gcp_billing_platform');
      expect(written[0].costUsd).toBe(10); // 6 unlabelled + 4 unattributable
    });
  });

  it('reports tableMissing, at ERROR, naming the configured table', async () => {
    // The real failure: a typo in the table reference. It has to be loud and it
    // has to print what was configured, because the name is the whole bug.
    bqQueryMock.mockRejectedValue(new Error('Not found: Table proj:dataset.table_v1_AABBCC'));
    const { runGcpBillingIngester } = await import('../gcp-billing-ingester');
    const out = await runGcpBillingIngester();
    expect(out.tableMissing).toBe(true);
    expect(out.ingested).toBe(0);
    expect(logError).toHaveBeenCalled();
    const [fields, message] = logError.mock.calls[0] as [Record<string, unknown>, string];
    expect(String(message)).toContain('does not exist');
    expect(fields.billingTable).toBe('proj.dataset.table_v1_AA_BB_CC');
  });

  it('treats a missing DATASET the same way', async () => {
    bqQueryMock.mockRejectedValue(new Error('Not found: Dataset proj:dataset'));
    const { runGcpBillingIngester } = await import('../gcp-billing-ingester');
    expect((await runGcpBillingIngester()).tableMissing).toBe(true);
  });

  it('does NOT swallow other failures that happen to say "not found"', async () => {
    // The old predicate matched bare "not found", so a missing COLUMN — a real
    // query bug, e.g. after a billing-export schema change — was reported as a
    // healthy skip. It must escape.
    bqQueryMock.mockRejectedValue(new Error('Unrecognized name: labelz; Field not found'));
    const { runGcpBillingIngester } = await import('../gcp-billing-ingester');
    await expect(runGcpBillingIngester()).rejects.toThrow('Field not found');
  });

  it('does NOT swallow a bare 404 either', async () => {
    // "404" alone was also matched, which covers permission and endpoint
    // problems that are not a missing table.
    bqQueryMock.mockRejectedValue(new Error('Request failed with status code 404'));
    const { runGcpBillingIngester } = await import('../gcp-billing-ingester');
    await expect(runGcpBillingIngester()).rejects.toThrow('404');
  });

  it('never advances the cursor when the table is missing', async () => {
    // Advancing past a day that was never read would make the gap permanent:
    // the daily job only ever moves forward, so the skipped day is never
    // revisited.
    bqQueryMock.mockRejectedValue(new Error('Not found: Table proj:dataset.t'));
    const { runGcpBillingIngester } = await import('../gcp-billing-ingester');
    await runGcpBillingIngester();
    expect(updateCursorMock).not.toHaveBeenCalled();
  });
});
