// get_connector_health Tool
//
// Answers questions like:
//   "Are any of my integrations failing?"
//   "Which connector is the slowest?"
//   "What's our Salesforce error rate this week?"
//
// Wraps:
//   - getConnectorHealth (Tenant Runtime — actions table grouped by connector)
//
// Returns null when Tenant Runtime is unreachable. The provider already
// handles HTTP failures gracefully by returning null, so the tool just
// surfaces that to the LLM.

import { getConnectorHealth } from '../data-providers';
import { COMPARE_TO_SCHEMA, TIME_RANGE_SCHEMA, formatTimeRangeForOutput, parseCompareToArg, parseTimeRangeArg } from './tool-helpers';
import type { InsightsTool, InsightsToolContext } from './types';
import type { ConnectorHealthEntry, TimeRange } from '../types';

interface ConnectorHealthPeriod {
  period: { start: string; end: string };
  /** Null when Tenant Runtime is unreachable. */
  connectors: ConnectorHealthEntry[] | null;
}

interface ConnectorHealthOutput {
  current: ConnectorHealthPeriod;
  comparison?: ConnectorHealthPeriod;
}

async function loadPeriod(tenantId: string, range: TimeRange): Promise<ConnectorHealthPeriod> {
  const connectors = await getConnectorHealth(tenantId, range);
  return {
    period: formatTimeRangeForOutput(range),
    connectors,
  };
}

export const getConnectorHealthTool: InsightsTool = {
  definition: {
    name: 'get_connector_health',
    description:
      'Per-connector health metrics from the action ledger: total actions, success and failure counts, average duration, and error rate, grouped by connector (e.g. Gmail, Salesforce, Slack). Returns null when the action ledger is unavailable. Use this when the user asks about integration reliability, connector errors, or which integrations are slow. Supports compare_to.',
    input_schema: {
      type: 'object',
      properties: {
        time_range: TIME_RANGE_SCHEMA,
        compare_to: COMPARE_TO_SCHEMA,
      },
      required: ['time_range'],
    },
  },
  async execute(input, ctx: InsightsToolContext): Promise<ConnectorHealthOutput> {
    const range = parseTimeRangeArg(input.time_range);
    const compareRange = parseCompareToArg(input.compare_to);

    const current = await loadPeriod(ctx.tenantId, range);

    if (compareRange) {
      const comparison = await loadPeriod(ctx.tenantId, compareRange);
      return { current, comparison };
    }

    return { current };
  },
};
