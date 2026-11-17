// Shared helpers for tool input parsing.
//
// Every data tool (except the point-in-time ones — get_oversight_config and
// get_workforce_composition) REQUIRES a `time_range`
// parameter shaped like our shared TimeRangeInput. We do not silently fall
// back to a default range: a tool that returns "last 30 days" when the user
// asked about "this quarter" is worse than an explicit error, because the
// user has no way to know the answer doesn't match the question.
//
// On missing or malformed input, parseTimeRangeArg throws with a clear
// message. The dispatcher catches the throw and wraps it as a tool error
// (ok=false), giving the LLM a chance to re-call with corrected input.
//
// `compare_to` is the same shape, optional. When present, the tool calls the
// underlying provider twice (current + comparison) so the LLM can compute
// deltas. Tools that don't support compare_to silently ignore it.

import { resolveTimeRange } from '../time-range';
import type { TimeRangeInput } from '../shared-types';
import type { TimeRange } from '../types';

const ALLOWED_PRESETS: ReadonlySet<string> = new Set([
  'today', 'yesterday',
  'this_week', 'last_week',
  'this_month', 'last_month',
  'last_7_days', 'last_30_days', 'last_90_days',
  'this_quarter', 'last_quarter',
  'this_year', 'last_year',
]);

/** Parse a tool's `time_range` argument into a concrete TimeRange.
 *  Throws on missing or malformed input — callers MUST pass a valid
 *  time_range. The dispatcher catches the throw and wraps it as a tool
 *  error so the LLM can re-call with corrected input. */
export function parseTimeRangeArg(raw: unknown): TimeRange {
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      'time_range is required. Pass either { preset: "this_week" | ... } or { start, end } as ISO timestamps.',
    );
  }

  const obj = raw as Record<string, unknown>;
  const input: TimeRangeInput = {};

  if (typeof obj.preset === 'string') {
    if (!ALLOWED_PRESETS.has(obj.preset)) {
      throw new Error(
        `Unknown time_range preset "${obj.preset}". Allowed: ${[...ALLOWED_PRESETS].join(', ')}.`,
      );
    }
    input.preset = obj.preset as TimeRangeInput['preset'];
  }
  if (typeof obj.start === 'string') input.start = obj.start;
  if (typeof obj.end === 'string') input.end = obj.end;

  if (!input.preset && !(input.start && input.end)) {
    throw new Error(
      'time_range must include either a "preset" or both "start" and "end" ISO timestamps.',
    );
  }

  // resolveTimeRange throws for invalid date strings or start >= end.
  // We let those throws propagate so the LLM sees the underlying message.
  return resolveTimeRange(input);
}

/** Parse an optional `compare_to` argument. Returns null if absent or
 *  unparseable. Tools should treat null as "don't compute a comparison." */
export function parseCompareToArg(raw: unknown): TimeRange | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;
  const input: TimeRangeInput = {};

  if (typeof obj.preset === 'string' && ALLOWED_PRESETS.has(obj.preset)) {
    input.preset = obj.preset as TimeRangeInput['preset'];
  }
  if (typeof obj.start === 'string') input.start = obj.start;
  if (typeof obj.end === 'string') input.end = obj.end;

  if (!input.preset && !(input.start && input.end)) return null;

  try {
    return resolveTimeRange(input);
  } catch {
    return null;
  }
}

/** Standard JSON-schema fragment for time_range, reused across every
 *  time-ranged tool. Each tool's input_schema also lists 'time_range' in
 *  its `required` array — this constant just describes the shape.
 *  IMPORTANT: time_range is REQUIRED on every tool that uses it. Tools must
 *  not default to a fallback range — silently using the wrong period would
 *  produce answers that don't match the question. */
export const TIME_RANGE_SCHEMA = {
  type: 'object' as const,
  description:
    'Required time range for the query. You MUST pass either a "preset" OR both "start" and "end" ISO date strings. Always ask the user for a time range if it is not clear from the question; do not guess.',
  properties: {
    preset: {
      type: 'string' as const,
      description: 'A preset like "this_week", "last_30_days", "this_quarter".',
      enum: [
        'today', 'yesterday',
        'this_week', 'last_week',
        'this_month', 'last_month',
        'last_7_days', 'last_30_days', 'last_90_days',
        'this_quarter', 'last_quarter',
        'this_year', 'last_year',
      ],
    },
    start: {
      type: 'string' as const,
      description: 'Start ISO timestamp (inclusive). Use with "end" for custom ranges.',
    },
    end: {
      type: 'string' as const,
      description: 'End ISO timestamp (exclusive). Use with "start" for custom ranges.',
    },
  },
};

/** Standard schema fragment for compare_to. Same shape as TIME_RANGE_SCHEMA
 *  but optional — tools that support comparison list this in `properties`
 *  but NOT in their `required` array. */
export const COMPARE_TO_SCHEMA = {
  ...TIME_RANGE_SCHEMA,
  description:
    'Optional comparison period for delta calculations. Same shape as time_range. Omit unless the user explicitly asks to compare two periods.',
};

/** Helper: format a TimeRange as a JSON-friendly object for tool output. */
export function formatTimeRangeForOutput(range: TimeRange): { start: string; end: string } {
  return {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
  };
}
