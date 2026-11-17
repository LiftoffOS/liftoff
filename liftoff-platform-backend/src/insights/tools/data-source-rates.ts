// get_data_source_rates Tool
//
// Answers questions like:
//   "What does a Zillow lookup cost?"
//   "How many Operating Units is a TikTok search?"
//   "Which data sources are free?"
//
// Wraps:
//   - getDataSources (src/data-sources/service.ts): every live data lookup the
//     platform runs, priced in Operating Units as the NEXT call at this
//     workspace's current band, through the booking path's own functions
//
// There is no page for these rates: a list of sources read on its own passes
// for everything Liftoff can reach, and a brand that is also a connection reads
// as a per-call charge on the customer's own account. Asked here, the question
// arrives with its context, so the rate is quoted inline.
//
// The full catalogue is several hundred call types, too much for one turn, so
// without a query the tool returns one line per source (its range and how many
// call types it has), and with one it returns the matching sources in full.

import { getDataSources, type DataSource } from '../../data-sources/service';
import type { InsightsTool, InsightsToolContext } from './types';

interface SourceSummary {
  source: string;
  category: string;
  callTypes: number;
  lowestOperatingUnitsPerCall: number;
  highestOperatingUnitsPerCall: number;
}

interface SourceDetail {
  source: string;
  category: string;
  calls: Array<{ callType: string; operatingUnitsPerCall: number }>;
}

interface DataSourceRatesOutput {
  sources: SourceSummary[] | SourceDetail[];
  /** How to read and relay the figures. Carried in the payload so the rules
   *  survive even when only the tool result is quoted back; one rule per
   *  string, because the sanitizer cuts any string past 500 characters. */
  interpretation: string[];
}

const INTERPRETATION = [
  'Figures are Operating Units for ONE call, at this workspace\'s current rate; 0 means the call is free.',
  'Write "Operating Units" in full to the person, never "OU" or "OUs".',
  'Name a source exactly as given here and never name any other company as where the data comes from.',
  'These are live data lookups the platform makes on the agents\' behalf, not the apps the workspace connects on the Connections page.',
  'Web search and reading public web pages are not priced here: if asked, say their cost shows up in the usage breakdown (get_cost_breakdown) rather than as a per-call rate.',
];

function summarise(s: DataSource): SourceSummary {
  const ous = s.calls.map((c) => c.ou);
  return {
    source: s.brand,
    category: s.category,
    callTypes: s.calls.length,
    lowestOperatingUnitsPerCall: Math.min(...ous),
    highestOperatingUnitsPerCall: Math.max(...ous),
  };
}

/** Sources whose name or category matches, with every call; failing that,
 *  sources with a matching call type, with just those calls. */
function match(sources: DataSource[], query: string): SourceDetail[] {
  const q = query.trim().toLowerCase();
  const detail = (s: DataSource, calls = s.calls): SourceDetail => ({
    source: s.brand,
    category: s.category,
    calls: calls.map((c) => ({ callType: c.label, operatingUnitsPerCall: c.ou })),
  });
  const bySource = sources.filter((s) => s.brand.toLowerCase().includes(q) || s.category.toLowerCase().includes(q));
  if (bySource.length > 0) return bySource.map((s) => detail(s));
  return sources
    .map((s) => ({ s, calls: s.calls.filter((c) => c.label.toLowerCase().includes(q)) }))
    .filter(({ calls }) => calls.length > 0)
    .map(({ s, calls }) => detail(s, calls));
}

export const getDataSourceRatesTool: InsightsTool = {
  definition: {
    name: 'get_data_source_rates',
    description:
      'What one live data lookup costs this workspace, in Operating Units per call, by data source ' +
      '(Zillow, TikTok, Crunchbase, SEC EDGAR and the rest) and call type. Use this when the person asks ' +
      'what a lookup or a data source costs, which sources are free, or how a data charge was reached. ' +
      'Pass `query` (a source, a category or a call type) to get every call type and its price; ' +
      'without it you get one line per source with its lowest and highest price.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A data source, category or call type to look up, e.g. "Zillow", "Social Media", "email".',
        },
      },
    },
  },
  async execute(input, ctx: InsightsToolContext): Promise<DataSourceRatesOutput> {
    const { sources } = await getDataSources(ctx.tenantId);
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    return {
      sources: query ? match(sources, query) : sources.map(summarise),
      interpretation: INTERPRETATION,
    };
  },
};
