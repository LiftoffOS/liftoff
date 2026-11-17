// tool-helpers tests — covers strict parsing of LLM-supplied time_range
// and compare_to arguments. parseTimeRangeArg THROWS on missing/malformed
// input (caught by the dispatcher and surfaced to the LLM as a tool error)
// rather than silently falling back to a default range that wouldn't match
// the user's question.

import { parseTimeRangeArg, parseCompareToArg } from '../tool-helpers';

describe('parseTimeRangeArg', () => {
  it('parses a valid preset', () => {
    const range = parseTimeRangeArg({ preset: 'last_7_days' });
    const durationDays = (range.end.getTime() - range.start.getTime()) / (24 * 60 * 60 * 1000);
    expect(durationDays).toBeCloseTo(7, 0);
  });

  it('parses valid start/end ISO timestamps', () => {
    const range = parseTimeRangeArg({
      start: '2026-03-01T00:00:00Z',
      end: '2026-04-01T00:00:00Z',
    });
    expect(range.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('throws for missing input (undefined)', () => {
    expect(() => parseTimeRangeArg(undefined)).toThrow(/time_range is required/);
  });

  it('throws for null input', () => {
    expect(() => parseTimeRangeArg(null)).toThrow(/time_range is required/);
  });

  it('throws for non-object input', () => {
    expect(() => parseTimeRangeArg('this_week')).toThrow(/time_range is required/);
    expect(() => parseTimeRangeArg(42)).toThrow(/time_range is required/);
  });

  it('throws for empty object input (no preset, no start/end)', () => {
    expect(() => parseTimeRangeArg({})).toThrow(/time_range must include/);
  });

  it('throws for unknown preset with the list of allowed presets', () => {
    expect(() => parseTimeRangeArg({ preset: 'last_eternity' })).toThrow(
      /Unknown time_range preset "last_eternity"/,
    );
  });

  it('throws for invalid date strings (propagates resolveTimeRange error)', () => {
    expect(() => parseTimeRangeArg({ start: 'not-a-date', end: 'also-not' })).toThrow();
  });

  it('throws when start >= end (propagates resolveTimeRange error)', () => {
    expect(() => parseTimeRangeArg({
      start: '2026-04-01T00:00:00Z',
      end: '2026-03-01T00:00:00Z',
    })).toThrow();
  });
});

describe('parseCompareToArg', () => {
  it('parses a valid preset', () => {
    const range = parseCompareToArg({ preset: 'last_week' });
    expect(range).toBeDefined();
  });

  it('returns null for missing input (compare_to is optional)', () => {
    expect(parseCompareToArg(undefined)).toBeNull();
    expect(parseCompareToArg(null)).toBeNull();
    expect(parseCompareToArg({})).toBeNull();
  });

  it('returns null for malformed preset', () => {
    expect(parseCompareToArg({ preset: 'next_galaxy' })).toBeNull();
  });

  it('returns null for invalid date range', () => {
    expect(parseCompareToArg({ start: 'bad', end: 'worse' })).toBeNull();
  });
});
