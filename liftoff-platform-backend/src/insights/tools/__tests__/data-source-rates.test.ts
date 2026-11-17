// get_data_source_rates: a summary line per source by default, every call type
// for a named source, and the matching call types for a call-type query.

const getDataSources = jest.fn();
jest.mock('../../../data-sources/service', () => ({
  getDataSources: (...a: unknown[]) => getDataSources(...a),
}));

import { getDataSourceRatesTool } from '../data-source-rates';
import { sanitizeToolResult } from '../sanitize';
import type { InsightsToolContext } from '../types';

const ctx: InsightsToolContext = { tenantId: 'tenant-1', accountId: 'a1', role: 'viewer' };

beforeEach(() => {
  getDataSources.mockResolvedValue({
    sources: [
      {
        brand: 'Zillow',
        category: 'Real Estate',
        calls: [
          { label: 'Search homes for sale', ou: 4.96 },
          { label: 'Property details', ou: 0.99 },
        ],
      },
      { brand: 'Nasdaq', category: 'Markets and Crypto', calls: [{ label: 'Stock quote', ou: 0 }] },
      { brand: 'Hunter', category: 'Companies, People and Contacts', calls: [{ label: 'Verify an email', ou: 0.2 }] },
    ],
  });
});

describe('get_data_source_rates', () => {
  it('prices this workspace: it reads the rates for the tenant in context', async () => {
    await getDataSourceRatesTool.execute({}, ctx);
    expect(getDataSources).toHaveBeenCalledWith('tenant-1');
  });

  it('returns one line per source, with its range, when asked for no source in particular', async () => {
    const out = await getDataSourceRatesTool.execute({}, ctx) as { sources: unknown[] };
    expect(out.sources).toEqual([
      { source: 'Zillow', category: 'Real Estate', callTypes: 2, lowestOperatingUnitsPerCall: 0.99, highestOperatingUnitsPerCall: 4.96 },
      { source: 'Nasdaq', category: 'Markets and Crypto', callTypes: 1, lowestOperatingUnitsPerCall: 0, highestOperatingUnitsPerCall: 0 },
      { source: 'Hunter', category: 'Companies, People and Contacts', callTypes: 1, lowestOperatingUnitsPerCall: 0.2, highestOperatingUnitsPerCall: 0.2 },
    ]);
  });

  it('returns every call type of a named source', async () => {
    const out = await getDataSourceRatesTool.execute({ query: 'zillow' }, ctx) as { sources: unknown[] };
    expect(out.sources).toEqual([{
      source: 'Zillow',
      category: 'Real Estate',
      calls: [
        { callType: 'Search homes for sale', operatingUnitsPerCall: 4.96 },
        { callType: 'Property details', operatingUnitsPerCall: 0.99 },
      ],
    }]);
  });

  it('matches a category', async () => {
    const out = await getDataSourceRatesTool.execute({ query: 'Real Estate' }, ctx) as { sources: Array<{ source: string }> };
    expect(out.sources.map((s) => s.source)).toEqual(['Zillow']);
  });

  it('returns only the matching call types for a call-type query', async () => {
    const out = await getDataSourceRatesTool.execute({ query: 'email' }, ctx) as { sources: unknown[] };
    expect(out.sources).toEqual([{
      source: 'Hunter',
      category: 'Companies, People and Contacts',
      calls: [{ callType: 'Verify an email', operatingUnitsPerCall: 0.2 }],
    }]);
  });

  it('tells the model how to relay the rates, and every rule survives the sanitizer whole', async () => {
    const out = await getDataSourceRatesTool.execute({}, ctx) as { interpretation: string[] };
    const sanitized = sanitizeToolResult(out) as { interpretation: string[] };
    expect(sanitized.interpretation).toEqual(out.interpretation);
    const rules = out.interpretation.join(' ');
    expect(rules).toMatch(/"Operating Units" in full/);
    expect(rules).toMatch(/never name any other company/);
    expect(rules).toMatch(/not the apps the workspace connects/);
  });
});
