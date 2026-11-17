// get_execution_trends Tool
//
// Answers questions like:
//   "How has activity changed over the past month?"
//   "When are agents most active?"
//   "Are we getting more errors lately?"
//
// Wraps:
//   - getAuditLogAggregation (DB — agent_audit_logs grouped by day/hour/month
//     with success/error and AI/human splits, plus top-N agents and totals)
//   - getInvocationStats (Tenant Runtime — token totals)

import { getAuditLogAggregation, getInvocationStats } from '../data-providers';
import { COMPARE_TO_SCHEMA, TIME_RANGE_SCHEMA, formatTimeRangeForOutput, parseCompareToArg, parseTimeRangeArg } from './tool-helpers';
import type { InsightsTool, InsightsToolContext } from './types';
import type { AuditLogAggregation, InvocationStats, TimeGrouping, TimeRange } from '../types';

interface ExecutionTrendsOutput {
  period: { start: string; end: string };
  grouping: TimeGrouping;
  audit: AuditLogAggregation | null;
  invocations: InvocationStats | null;
  comparison?: {
    period: { start: string; end: string };
    audit: AuditLogAggregation | null;
    invocations: InvocationStats | null;
  };
}

/** Pick a default time grouping based on the range duration. The LLM may
 *  pass `grouping` explicitly, but if it doesn't we choose hourly for
 *  ranges <2 days, daily for ranges <90 days, monthly for longer. */
function chooseGrouping(range: TimeRange, override?: unknown): TimeGrouping {
  if (override === 'hour' || override === 'day' || override === 'month') {
    return override;
  }
  const durationMs = range.end.getTime() - range.start.getTime();
  const hours = durationMs / (60 * 60 * 1000);
  if (hours <= 48) return 'hour';
  if (hours <= 90 * 24) return 'day';
  return 'month';
}

async function loadForRange(
  tenantId: string,
  range: TimeRange,
  grouping: TimeGrouping,
): Promise<{ audit: AuditLogAggregation | null; invocations: InvocationStats | null }> {
  const [audit, invocations] = await Promise.all([
    getAuditLogAggregation(tenantId, range, grouping),
    getInvocationStats(tenantId, range),
  ]);
  return { audit, invocations };
}

export const getExecutionTrendsTool: InsightsTool = {
  definition: {
    name: 'get_execution_trends',
    description:
      'Time-series volume and outcome trends: actions per day/hour/month, success vs error counts, AI vs human action splits, the top agents by activity, and total invocation token counts. Use this when the user asks how activity has changed over time or about error patterns. Supports period comparison via compare_to.',
    input_schema: {
      type: 'object',
      properties: {
        time_range: TIME_RANGE_SCHEMA,
        compare_to: COMPARE_TO_SCHEMA,
        grouping: {
          type: 'string',
          description:
            'How to bucket the time series. Defaults to "hour" for ranges ≤48h, "day" for ranges ≤90d, "month" for longer. Override only when the user explicitly asks for a different granularity.',
          enum: ['hour', 'day', 'month'],
        },
      },
      required: ['time_range'],
    },
  },
  async execute(input, ctx: InsightsToolContext): Promise<ExecutionTrendsOutput> {
    const range = parseTimeRangeArg(input.time_range);
    const compareRange = parseCompareToArg(input.compare_to);
    const grouping = chooseGrouping(range, input.grouping);

    const current = await loadForRange(ctx.tenantId, range, grouping);

    const out: ExecutionTrendsOutput = {
      period: formatTimeRangeForOutput(range),
      grouping,
      audit: current.audit,
      invocations: current.invocations,
    };

    if (compareRange) {
      // Use the same grouping for the comparison so deltas are apples-to-apples.
      const comparison = await loadForRange(ctx.tenantId, compareRange, grouping);
      out.comparison = {
        period: formatTimeRangeForOutput(compareRange),
        audit: comparison.audit,
        invocations: comparison.invocations,
      };
    }

    return out;
  },
};
