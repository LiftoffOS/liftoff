import {
  firstOfMonthUTC,
  addMonths,
  formatYmd01,
  partitionNameFor,
  countRunwayMonths,
  MIN_RUNWAY_MONTHS,
} from '../partitions/provision.js';

describe('month arithmetic', () => {
  it('truncates to the first of the month in UTC', () => {
    expect(formatYmd01(firstOfMonthUTC(new Date('2026-08-31T23:59:59Z')))).toBe('2026-08-01');
  });

  it('crosses a year boundary', () => {
    expect(formatYmd01(addMonths(firstOfMonthUTC(new Date('2026-11-15T00:00:00Z')), 3))).toBe(
      '2027-02-01',
    );
  });

  it('pads single-digit months', () => {
    expect(formatYmd01(new Date(Date.UTC(2027, 0, 1)))).toBe('2027-01-01');
  });

  it('walks 18 months without drifting off a month boundary', () => {
    const start = firstOfMonthUTC(new Date('2026-08-08T12:00:00Z'));
    const last = addMonths(start, 17);
    expect(formatYmd01(last)).toBe('2028-01-01');
  });
});

describe('partitionNameFor', () => {
  it('matches the naming migration 014 used', () => {
    expect(partitionNameFor(new Date(Date.UTC(2027, 11, 1)))).toBe(
      'developer_proxy_usage_log_y2027_m12',
    );
  });

  it('pads the month', () => {
    expect(partitionNameFor(new Date(Date.UTC(2028, 0, 1)))).toBe(
      'developer_proxy_usage_log_y2028_m01',
    );
  });

  // The 2026 children are still named byok_usage_log_y2026_*, because migration
  // 009 renamed the parent and indexes but not the partitions. New partitions
  // use the current name; coverage is decided on declared bounds, so the two
  // schemes coexist without the provisioner needing to know about the old one.
  it('does not emit the pre-rename name', () => {
    expect(partitionNameFor(new Date(Date.UTC(2026, 3, 1)))).not.toContain('byok_usage_log');
  });
});

describe('countRunwayMonths', () => {
  // A pool whose coverage query answers true for the listed month starts.
  function poolCovering(months: string[]) {
    const client = {
      query: async (_sql: string, params: unknown[]) =>
        months.includes(String(params[1])) ? { rows: [{ child: 'p' }] } : { rows: [] },
      release: () => undefined,
    };
    return { connect: async () => client } as never;
  }

  const now = new Date('2026-08-08T00:00:00Z');

  it('counts consecutive months from the current one', async () => {
    const pool = poolCovering(['2026-08-01', '2026-09-01', '2026-10-01']);
    await expect(countRunwayMonths(pool, now)).resolves.toBe(3);
  });

  it('stops at the first gap rather than counting past it', async () => {
    // A month beyond a gap is unreachable in practice — inserts fail at the
    // gap — so the honest number is where the unbroken run ends.
    const pool = poolCovering(['2026-08-01', '2026-09-01', '2026-11-01']);
    await expect(countRunwayMonths(pool, now)).resolves.toBe(2);
  });

  it('returns zero when the current month is not covered', async () => {
    const pool = poolCovering(['2026-09-01']);
    await expect(countRunwayMonths(pool, now)).resolves.toBe(0);
  });

  it('keeps a minimum that leaves time to act', () => {
    // Below this the job fails and the job-failure alert fires. It has to be
    // more than one month: the alternative signal is partition-overflow, which
    // only fires once rows are already being lost.
    expect(MIN_RUNWAY_MONTHS).toBeGreaterThanOrEqual(3);
  });
});
