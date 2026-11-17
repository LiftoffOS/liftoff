// Time Range Tests
// Edge cases: DST transitions, timezone, boundary, invalid input

import { resolveTimeRange, getComparisonPeriod } from '../time-range';

describe('resolveTimeRange', () => {
  // Save original Date and restore after each test
  const RealDate = global.Date;

  afterEach(() => {
    global.Date = RealDate;
  });

  function mockNow(isoString: string) {
    const fixedNow = new RealDate(isoString).getTime();
    const MockDate = class extends RealDate {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(fixedNow);
        } else {
          // @ts-expect-error - spreading args into Date constructor
          super(...args);
        }
      }
      static now() {
        return fixedNow;
      }
    } as any;
    global.Date = MockDate;
  }

  describe('custom range', () => {
    it('should resolve custom start/end dates', () => {
      const result = resolveTimeRange({
        start: '2024-01-01T00:00:00Z',
        end: '2024-01-31T23:59:59Z',
      });
      expect(result.start.toISOString()).toBe('2024-01-01T00:00:00.000Z');
      expect(result.end.toISOString()).toBe('2024-01-31T23:59:59.000Z');
    });

    it('should throw on invalid date format', () => {
      expect(() => resolveTimeRange({ start: 'not-a-date', end: '2024-01-31' }))
        .toThrow('Invalid date format');
    });

    it('should throw when start >= end', () => {
      expect(() => resolveTimeRange({
        start: '2024-02-01T00:00:00Z',
        end: '2024-01-01T00:00:00Z',
      })).toThrow('start must be before end');
    });

    it('should throw when start equals end', () => {
      expect(() => resolveTimeRange({
        start: '2024-01-01T00:00:00Z',
        end: '2024-01-01T00:00:00Z',
      })).toThrow('start must be before end');
    });
  });

  describe('presets', () => {
    it('should throw when neither preset nor start/end provided', () => {
      expect(() => resolveTimeRange({})).toThrow('Either preset or start/end must be provided');
    });

    it('should throw on unknown preset', () => {
      expect(() => resolveTimeRange({ preset: 'unknown_period' as any }))
        .toThrow('Unknown time range preset');
    });

    it('should resolve today preset', () => {
      mockNow('2024-06-15T14:30:00Z');
      const result = resolveTimeRange({ preset: 'today' });
      expect(result.start.toISOString()).toBe('2024-06-15T00:00:00.000Z');
      // end should be approximately "now"
      expect(result.end.getTime()).toBeGreaterThan(result.start.getTime());
    });

    it('should resolve yesterday preset', () => {
      mockNow('2024-06-15T14:30:00Z');
      const result = resolveTimeRange({ preset: 'yesterday' });
      expect(result.start.toISOString()).toBe('2024-06-14T00:00:00.000Z');
      expect(result.end.toISOString()).toBe('2024-06-15T00:00:00.000Z');
    });

    it('should resolve this_week preset (Monday start)', () => {
      // June 15 2024 is a Saturday
      mockNow('2024-06-15T14:30:00Z');
      const result = resolveTimeRange({ preset: 'this_week' });
      // Monday was June 10
      expect(result.start.toISOString()).toBe('2024-06-10T00:00:00.000Z');
    });

    it('should resolve this_week on a Sunday', () => {
      // June 16 2024 is a Sunday
      mockNow('2024-06-16T14:30:00Z');
      const result = resolveTimeRange({ preset: 'this_week' });
      // Monday was June 10
      expect(result.start.toISOString()).toBe('2024-06-10T00:00:00.000Z');
    });

    it('should resolve this_week on a Monday', () => {
      // June 10 2024 is a Monday
      mockNow('2024-06-10T14:30:00Z');
      const result = resolveTimeRange({ preset: 'this_week' });
      expect(result.start.toISOString()).toBe('2024-06-10T00:00:00.000Z');
    });

    it('should resolve last_month on March 31 (Feb boundary)', () => {
      mockNow('2024-03-31T12:00:00Z');
      const result = resolveTimeRange({ preset: 'last_month' });
      expect(result.start.toISOString()).toBe('2024-02-01T00:00:00.000Z');
      expect(result.end.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    });

    it('should resolve last_month on March 31 in non-leap year', () => {
      mockNow('2023-03-31T12:00:00Z');
      const result = resolveTimeRange({ preset: 'last_month' });
      expect(result.start.toISOString()).toBe('2023-02-01T00:00:00.000Z');
      expect(result.end.toISOString()).toBe('2023-03-01T00:00:00.000Z');
    });

    it('should resolve this_quarter correctly in Q1', () => {
      mockNow('2024-02-15T12:00:00Z');
      const result = resolveTimeRange({ preset: 'this_quarter' });
      expect(result.start.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should resolve this_quarter correctly in Q4', () => {
      mockNow('2024-11-15T12:00:00Z');
      const result = resolveTimeRange({ preset: 'this_quarter' });
      expect(result.start.toISOString()).toBe('2024-10-01T00:00:00.000Z');
    });

    it('should resolve last_quarter from Q1 (wraps to previous year Q4)', () => {
      mockNow('2024-02-15T12:00:00Z');
      const result = resolveTimeRange({ preset: 'last_quarter' });
      expect(result.start.toISOString()).toBe('2023-10-01T00:00:00.000Z');
      expect(result.end.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should resolve last_year', () => {
      mockNow('2024-06-15T12:00:00Z');
      const result = resolveTimeRange({ preset: 'last_year' });
      expect(result.start.toISOString()).toBe('2023-01-01T00:00:00.000Z');
      expect(result.end.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should resolve last_7_days', () => {
      mockNow('2024-06-15T12:00:00Z');
      const result = resolveTimeRange({ preset: 'last_7_days' });
      const durationMs = result.end.getTime() - result.start.getTime();
      expect(durationMs).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should resolve last_30_days', () => {
      mockNow('2024-06-15T12:00:00Z');
      const result = resolveTimeRange({ preset: 'last_30_days' });
      const durationMs = result.end.getTime() - result.start.getTime();
      expect(durationMs).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('should resolve last_90_days', () => {
      mockNow('2024-06-15T12:00:00Z');
      const result = resolveTimeRange({ preset: 'last_90_days' });
      const durationMs = result.end.getTime() - result.start.getTime();
      expect(durationMs).toBe(90 * 24 * 60 * 60 * 1000);
    });
  });
});

describe('getComparisonPeriod', () => {
  it('should return previous period of same length', () => {
    const range = {
      start: new Date('2024-06-08T00:00:00Z'),
      end: new Date('2024-06-15T00:00:00Z'),
    };
    const comparison = getComparisonPeriod(range);
    expect(comparison.start.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(comparison.end.toISOString()).toBe('2024-06-08T00:00:00.000Z');
  });

  it('should handle 1-day range', () => {
    const range = {
      start: new Date('2024-06-15T00:00:00Z'),
      end: new Date('2024-06-16T00:00:00Z'),
    };
    const comparison = getComparisonPeriod(range);
    expect(comparison.start.toISOString()).toBe('2024-06-14T00:00:00.000Z');
    expect(comparison.end.toISOString()).toBe('2024-06-15T00:00:00.000Z');
  });

  it('should handle 30-day range', () => {
    const range = {
      start: new Date('2024-06-01T00:00:00Z'),
      end: new Date('2024-07-01T00:00:00Z'),
    };
    const comparison = getComparisonPeriod(range);
    expect(comparison.start.toISOString()).toBe('2024-05-02T00:00:00.000Z');
    expect(comparison.end.toISOString()).toBe('2024-06-01T00:00:00.000Z');
  });

  it('comparison period has same duration as original', () => {
    const range = {
      start: new Date('2024-03-01T00:00:00Z'),
      end: new Date('2024-04-15T12:00:00Z'),
    };
    const comparison = getComparisonPeriod(range);
    const originalDuration = range.end.getTime() - range.start.getTime();
    const comparisonDuration = comparison.end.getTime() - comparison.start.getTime();
    expect(comparisonDuration).toBe(originalDuration);
  });
});
