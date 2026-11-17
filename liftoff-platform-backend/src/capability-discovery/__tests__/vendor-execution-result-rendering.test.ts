// What a capability run hands the model is the rendered result — whole
// records, and a count of what was left out — on both execution paths: the
// platform-funded actor run and the connector-function run. The rendering
// lives in one module; this pins that both paths reach it.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
  getConnectorServiceClient: jest.fn(),
  listConnectorsForTenant: jest.fn(),
}));
jest.mock('../../connectors/connector-type-registry', () => ({ fetchRegistry: jest.fn() }));
jest.mock('../../mcp/tool-classifier', () => ({ toolClassifier: { getCachedClassification: jest.fn() } }));
jest.mock('../evidence', () => ({ recordUsageEvidence: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: jest.fn().mockResolvedValue(1),
  resolveAccountIdForTenant: jest.fn().mockResolvedValue('acct-1'),
}));
jest.mock('../apify-executor', () => ({ runApifyActor: jest.fn() }));
jest.mock('../../billing/execution-guard', () => ({ checkExecutionAllowed: jest.fn().mockResolvedValue({ allowed: true }) }));

import * as fs from 'fs';
import * as path from 'path';
import { toolClassifier } from '../../mcp/tool-classifier';
import { getCatalog, getConnectorServiceClient, listConnectorsForTenant } from '../../connectors/connector-service-client';
import { fetchRegistry } from '../../connectors/connector-type-registry';
import { runApifyActor } from '../apify-executor';
import { executeVendorTool } from '../vendor-execution';
import { CAPABILITY_RESULT_BUDGET } from '../result-rendering';
import { log } from '../../infrastructure/logging';

const executeMock = jest.fn();

/** A real Parse response for Palo Alto: 41 listings under `data`, beside 71
 *  map pins and the envelope's own counts. */
const PARSE_ENVELOPE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'parse-search-homes-for-sale.json'), 'utf8'),
) as { status: string; data: { listings: unknown[] } };

function post(i: number): Record<string, unknown> {
  return {
    id: `p${i}`,
    title: `Post ${i}`,
    subreddit: 'shopify',
    selftext: 'x'.repeat(4000),
    permalink: `https://www.reddit.com/r/shopify/comments/p${i}/`,
    author_fullname: null,
    url: null,
    score: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  executeMock.mockReset();
  (getCatalog as jest.Mock).mockResolvedValue({
    connectors: [
      { type: 'apify', status: 'internal' },
      { type: 'zoho_crm', status: 'available' },
      { type: 'locus', status: 'internal' },
    ],
  });
  (fetchRegistry as jest.Mock).mockResolvedValue(
    new Map<string, { connectorType: string; functionNames: string[] }>([
      ['zoho_crm', { connectorType: 'zoho_crm', functionNames: ['list_contacts'] }],
      ['locus', { connectorType: 'locus', functionNames: ['home_listings_search_homes_for_sale'] }],
    ]),
  );
  (toolClassifier.getCachedClassification as jest.Mock).mockResolvedValue({
    categories: ['read'],
    isManualOverride: false,
    toolDescriptionHash: 'h',
  });
  (getConnectorServiceClient as jest.Mock).mockReturnValue({ execute: executeMock });
  (listConnectorsForTenant as jest.Mock).mockResolvedValue([{ id: 'conn-zoho-1', type: 'zoho_crm', status: 'active' }]);
});

describe('the content a capability run hands the model', () => {
  it('an actor run: whole records within the budget, and how many were left out', async () => {
    const items = Array.from({ length: 40 }, (_, i) => post(i));
    (runApifyActor as jest.Mock).mockResolvedValue({ success: true, items, costUsd: 0.04 });

    const out = await executeVendorTool({
      tenantId: 't1', accountId: 'acct-7', connectorType: 'apify', toolName: 'run_actor',
      args: { queries: ['Shopify'] }, presetArgs: { actorId: 'someone/reddit-search' }, caller: 'caio',
    });

    expect(out.success).toBe(true);
    const content = out.success ? out.content : '';
    expect(content.length).toBeLessThanOrEqual(CAPABILITY_RESULT_BUDGET);
    const [body, omitted] = content.split('\n\n');
    const shown = JSON.parse(body) as Array<{ permalink: string }>;
    expect(shown.length).toBeGreaterThanOrEqual(10);
    expect(shown[shown.length - 1].permalink).toMatch(/^https:/);
    expect(omitted).toMatch(new RegExp(`^${shown.length} of 40 results shown; ${40 - shown.length} omitted for length`));
    // The structured result rides along untouched for a caller that wants it.
    expect(out.success && out.structuredContent).toBe(items);
  });

  it('a connector-function run: the list field of the result, rendered the same way', async () => {
    const contacts = Array.from({ length: 60 }, (_, i) => ({
      id: `c${i}`, name: `Contact ${i}`, notes: 'n'.repeat(2000), phone: null, tags: [],
    }));
    executeMock.mockResolvedValue({ success: true, result: { total: 60, items: contacts }, costUsd: 0, fundingSource: 'tenant_key' });

    const out = await executeVendorTool({
      tenantId: 't1', accountId: 'acct-7', connectorType: 'zoho_crm', toolName: 'list_contacts',
      args: {}, caller: 'agent',
    });

    expect(out.success).toBe(true);
    const content = out.success ? out.content : '';
    expect(content.length).toBeLessThanOrEqual(CAPABILITY_RESULT_BUDGET);
    const [body, omitted] = content.split('\n\n');
    const parsed = JSON.parse(body) as { total: number; items: Array<{ id: string; notes: string }> };
    expect(parsed.total).toBe(60);
    expect(parsed.items.length).toBeGreaterThan(1);
    expect(parsed.items[0].notes.endsWith('…[+1200 chars]')).toBe(true);
    expect(omitted).toMatch(new RegExp(`^${parsed.items.length} of 60 results shown in "items"`));
  });

  it('counts the records of an ENVELOPED result: the ledger says items=41, not null', async () => {
    // `items` on the cost log and the evidence row is the answer to "how much
    // did that call return". A Parse response keeps its records under `data`,
    // so without this the count comes back null and the call is on record as
    // having returned nothing countable.
    executeMock.mockResolvedValue({ success: true, result: PARSE_ENVELOPE, costUsd: 0.02525, fundingSource: 'platform_key' });

    const out = await executeVendorTool({
      tenantId: 't1', accountId: 'acct-7', connectorType: 'locus', toolName: 'home_listings_search_homes_for_sale',
      args: { location: 'Palo Alto, CA' }, caller: 'assistant',
    });

    expect(out.success).toBe(true);
    const cost = (log.info as jest.Mock).mock.calls.find(
      ([fields]) => (fields as { metric?: string }).metric === 'vendor_tool_cost',
    );
    expect(cost?.[0]).toEqual(expect.objectContaining({ items: 41, connectorType: 'locus' }));
    // And the model reads the listings, named by where they sit.
    const content = out.success ? out.content : '';
    expect(content.length).toBeLessThanOrEqual(CAPABILITY_RESULT_BUDGET);
    expect(content).toContain('results shown in "data.listings"');
  });
});
