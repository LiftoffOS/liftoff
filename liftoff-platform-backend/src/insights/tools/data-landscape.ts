// get_data_landscape Tool
//
// Answers questions like:
//   "What do my AI teammates actually have access to?"
//   "How much of our Slack history has been picked up?"
//   "Is there enough in the CRM for an agent to work from?"
//
// Wraps:
//   - getDataLandscape (Tenant Runtime — the connector entity census plus the
//     already-indexed content counts)
//
// The advisor was previously grounded only in what agents DID: invocations,
// costs, approvals. It could not see what they had to work WITH, so a question
// about coverage got an answer reasoned from activity. This closes that.
//
// COUNTS ARE A FLOOR. The census records what has been catalogued, which is
// never more than what exists and is usually less. The tool says so in its own
// description and in its output, because an advisor that reports "you have 12
// channels" when the census has merely seen 12 is stating a false total.

import { getDataLandscape } from '../data-providers';
import type { InsightsTool, InsightsToolContext } from './types';
import type { DataLandscapeSummary } from '../../internal-agents/distill-landscape-injection';

interface DataLandscapeOutput {
  /** Null when the runtime is unreachable — NOT an empty workspace. */
  landscape: DataLandscapeSummary | null;
  /** How to read the numbers. Carried in the payload so the caveat survives
   *  even when only the tool result is quoted back. */
  interpretation: string;
}

const AVAILABLE_NOTE =
  'These counts are what has been catalogued so far, which is a floor rather than a total. ' +
  'A low number means little has been catalogued, not that little exists. Do not report an ' +
  'absence on the basis of these figures.';

const UNAVAILABLE_NOTE =
  'The workspace data catalogue could not be read just now. This says nothing about how much ' +
  'data exists — report it as unavailable, not as empty.';

export const getDataLandscapeTool: InsightsTool = {
  definition: {
    name: 'get_data_landscape',
    description:
      'What is actually in the systems this workspace is connected to: entity counts per ' +
      'connector and entity type, how much content has already been fetched and indexed, and ' +
      'how far back the record goes. Returns null when the tenant runtime is unavailable. ' +
      'Use this when the user asks what their AI teammates can see, how much history has been ' +
      'picked up, or whether a system has enough in it to work from. ' +
      'The counts are what has been CATALOGUED so far — a floor, never a total.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  async execute(_input, ctx: InsightsToolContext): Promise<DataLandscapeOutput> {
    const landscape = await getDataLandscape(ctx.tenantId);
    return {
      landscape,
      interpretation: landscape ? AVAILABLE_NOTE : UNAVAILABLE_NOTE,
    };
  },
};
