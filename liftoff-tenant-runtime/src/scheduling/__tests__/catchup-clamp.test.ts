// F4b — dropping a tick that arrived long after the time it was for.
//
// Cloud Scheduler retries a missed fire under its own attemptDeadline, so a
// long outage ends with a burst of stale ticks arriving together. For a
// monitor-shaped routine that is worse than useless: it reports on windows that
// have already closed, several times over.

import {
  catchupWindowMs,
  estimateCronPeriodMs,
  tickAgeMs,
} from '../catchup-clamp';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('estimateCronPeriodMs', () => {
  it.each([
    ['*/5 * * * *', 5 * MIN],
    ['*/15 * * * *', 15 * MIN],
    ['0 * * * *', HOUR],
    ['30 * * * *', HOUR],
    ['0 */6 * * *', 6 * HOUR],
    ['0 9 * * *', 24 * HOUR],
    ['0 9 * * 1', 7 * 24 * HOUR],
  ])('reads %s', (expr, expected) => {
    expect(estimateCronPeriodMs(expr)).toBe(expected);
  });

  it('returns null for a shape it cannot read confidently', () => {
    // Better to admit ignorance than to clamp a legitimate tick on a guess.
    expect(estimateCronPeriodMs('0 9,17 * * *')).toBeNull();
    expect(estimateCronPeriodMs('bogus')).toBeNull();
    expect(estimateCronPeriodMs(undefined)).toBeNull();
  });
});

describe('catchupWindowMs', () => {
  it('is half the period for an ordinary schedule', () => {
    expect(catchupWindowMs(4 * HOUR)).toBe(2 * HOUR);
    expect(catchupWindowMs(30 * MIN)).toBe(15 * MIN);
  });

  it('never drops below two minutes, however tight the schedule', () => {
    // A one-minute routine would otherwise have a 30s window and lose ticks to
    // ordinary queue latency.
    expect(catchupWindowMs(1 * MIN)).toBe(2 * MIN);
  });

  it('never exceeds two hours, however long the period', () => {
    expect(catchupWindowMs(30 * 24 * HOUR)).toBe(2 * HOUR);
  });

  it('falls back to the maximum window when the period is unknown', () => {
    // Erring toward running the tick: a missed report is worse than a late one.
    expect(catchupWindowMs(null)).toBe(2 * HOUR);
  });
});

describe('tickAgeMs', () => {
  const now = new Date('2026-08-05T12:00:00Z');

  it('measures how late the tick is', () => {
    expect(tickAgeMs('2026-08-05T11:30:00Z', now)).toBe(30 * MIN);
  });

  it('is negative for a tick that arrived early', () => {
    expect(tickAgeMs('2026-08-05T12:05:00Z', now)).toBe(-5 * MIN);
  });

  it('returns null when there is nothing to be late against', () => {
    // A manual run or an older job carries no scheduled time; it is not stale.
    expect(tickAgeMs(undefined, now)).toBeNull();
    expect(tickAgeMs('not-a-date', now)).toBeNull();
  });
});

describe('the clamp decision', () => {
  /** What the handler does: drop when age exceeds the window. */
  function isStale(scheduledAt: string | undefined, cronExpr: string | undefined, now: Date): boolean {
    const age = tickAgeMs(scheduledAt, now);
    if (age === null) return false;
    return age > catchupWindowMs(estimateCronPeriodMs(cronExpr));
  }
  const now = new Date('2026-08-05T12:00:00Z');

  it('runs a tick that is only slightly late', () => {
    expect(isStale('2026-08-05T11:59:00Z', '*/15 * * * *', now)).toBe(false);
  });

  it('drops a 15-minute routine tick that is an hour late', () => {
    expect(isStale('2026-08-05T11:00:00Z', '*/15 * * * *', now)).toBe(true);
  });

  it('still runs a daily report that is an hour late', () => {
    // Half of 24h, clamped to 2h — an hour late on a daily report is fine.
    expect(isStale('2026-08-05T11:00:00Z', '0 9 * * *', now)).toBe(false);
  });

  it('drops a daily report that is a day late', () => {
    expect(isStale('2026-08-04T12:00:00Z', '0 9 * * *', now)).toBe(true);
  });
});
