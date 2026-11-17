// Time Range Resolution
// Converts TimeRangeInput presets to concrete Date ranges.
// All timestamps are UTC.

import type { TimeRangeInput } from './shared-types';
import type { TimeRange } from './types';

/**
 * Resolve a TimeRangeInput (preset or custom ISO dates) to a concrete TimeRange.
 * Start is inclusive, end is exclusive.
 */
export function resolveTimeRange(input: TimeRangeInput): TimeRange {
  if (input.start && input.end) {
    const start = new Date(input.start);
    const end = new Date(input.end);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid date format in time range');
    }
    if (start >= end) {
      throw new Error('Time range start must be before end');
    }
    return { start, end };
  }

  if (!input.preset) {
    throw new Error('Either preset or start/end must be provided');
  }

  const now = new Date();

  switch (input.preset) {
    case 'today': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { start, end: now };
    }
    case 'yesterday': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { start, end };
    }
    case 'this_week': {
      const dayOfWeek = now.getUTCDay();
      const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset));
      return { start, end: now };
    }
    case 'last_week': {
      const dayOfWeek = now.getUTCDay();
      const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset));
      const lastMonday = new Date(thisMonday);
      lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
      return { start: lastMonday, end: thisMonday };
    }
    case 'this_month': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { start, end: now };
    }
    case 'last_month': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { start, end };
    }
    case 'last_7_days': {
      const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { start, end: now };
    }
    case 'last_30_days': {
      const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { start, end: now };
    }
    case 'last_90_days': {
      const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      return { start, end: now };
    }
    case 'this_quarter': {
      const quarterMonth = Math.floor(now.getUTCMonth() / 3) * 3;
      const start = new Date(Date.UTC(now.getUTCFullYear(), quarterMonth, 1));
      return { start, end: now };
    }
    case 'last_quarter': {
      const currentQuarterMonth = Math.floor(now.getUTCMonth() / 3) * 3;
      const end = new Date(Date.UTC(now.getUTCFullYear(), currentQuarterMonth, 1));
      const start = new Date(Date.UTC(now.getUTCFullYear(), currentQuarterMonth - 3, 1));
      return { start, end };
    }
    case 'this_year': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      return { start, end: now };
    }
    case 'last_year': {
      const start = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      return { start, end };
    }
    default:
      throw new Error(`Unknown time range preset: ${input.preset}`);
  }
}

/**
 * Get the comparison period of the same length, immediately before the given range.
 * E.g., if range is 7 days, comparison is the 7 days before that.
 */
export function getComparisonPeriod(range: TimeRange): TimeRange {
  const durationMs = range.end.getTime() - range.start.getTime();
  const comparisonStart = new Date(range.start.getTime() - durationMs);
  const comparisonEnd = new Date(range.start.getTime());
  return { start: comparisonStart, end: comparisonEnd };
}
