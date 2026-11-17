/**
 * The strict web-tool bypass is a property of the FUNDING, not of the vendor.
 *
 * browser_use and steel are the vendors that can be funded either way: the
 * platform holds a key of its own for each, so a workspace that connected
 * nothing browses on OUR account, while a workspace that connected its own key
 * pays the vendor directly. Both are the same vendor, on the same table, and
 * they charge in opposite directions.
 *
 * Both ways of getting this wrong are silent, which is why they are pinned here
 * rather than left to a reading of the branch:
 *
 *   - bypass unconditionally  → every platform-funded browser hour is given
 *                               away, and the ledger looks tidy while it happens
 *   - drop the vendor outright → a workspace on its own key is charged a second
 *                               time for hours it already paid the vendor for
 */

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockClientQuery = jest.fn();
const mockClient = { query: mockClientQuery, release: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) => fn(mockClient)),
  withTenantScope: jest.fn(),
  getPool: jest.fn(),
}));

const mockApplyOuConsumption = jest.fn();
jest.mock('../ou-bucket-service', () => ({
  applyOuConsumption: (...a: unknown[]) => mockApplyOuConsumption(...a),
  applyOuRefund: jest.fn(),
  getOuDefinitionRateUsd: jest.fn().mockResolvedValue(0.01),
}));

jest.mock('../reload-drain', () => ({
  applyReloadDrain: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../event-classification', () => ({
  classifyChargeability: jest.fn().mockReturnValue('customer'),
  VOICE_DICTATION_PURPOSE: 'voice_dictation',
}));

import { ingestEventWithBuckets } from '../repository';
import type { CostAttributionEvent } from '../types';

type Template = Omit<
  CostAttributionEvent,
  'sourceId' | 'costUsd' | 'ouConsumed' | 'customerCostUsd' | 'costBucket'
>;

const template = (over: Partial<Template> = {}): Template => ({
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  connector: 'browser_use',
  eventType: 'web_tool',
  actionType: 'web_fetch_advanced',
  source: 'tenant_runtime',
  occurredAt: new Date('2026-09-04T00:00:00Z'),
  ...over,
});

/** The bound parameters of the ledger insert, in the order the INSERT lists
 *  them. Read positionally because the three branches share one column list and
 *  differ only in what they bind. */
function insertParams(): unknown[] | null {
  const call = mockClientQuery.mock.calls.find(
    (c) => String(c[0]).includes('INSERT INTO cost_attribution_events'),
  );
  return call ? (call[1] as unknown[]) : null;
}

const OU_CONSUMED = 23;
const CUSTOMER_COST = 24;
const COST_BUCKET = 25;
const COST_USD = 19;

describe('a workspace on its OWN Browser Use key', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientQuery.mockResolvedValue({ rowCount: 1, rows: [] });
  });

  it('records the spend and debits nothing', async () => {
    await ingestEventWithBuckets('account-1', 'evt-1', 0.42, template({ webToolFunding: 'tenant_key' }));

    const p = insertParams();
    expect(p).not.toBeNull();
    // cost_usd stays NON-zero: it is what the workspace paid the vendor, and it
    // is what a per-tenant "what did we spend on Browser Use" answer is made of.
    expect(p![COST_USD]).toBe(0.42);
    expect(p![OU_CONSUMED]).toBe(0);
    expect(p![CUSTOMER_COST]).toBe(0);
    // 'unknown' keeps the row out of every customer-billed total, which all
    // filter on cost_bucket NOT IN ('unknown','platform_overhead').
    expect(p![COST_BUCKET]).toBe('unknown');
    expect(mockApplyOuConsumption).not.toHaveBeenCalled();
  });

  it('is what an event carrying no funding at all is treated as', async () => {
    // The behaviour a browser_use row had before the platform took a key, so an
    // event still in flight from an older runtime keeps the charge it was
    // published under. It also errs the safe way: not charging is our loss,
    // charging twice is the customer's.
    await ingestEventWithBuckets('account-1', 'evt-2', 0.42, template());

    expect(insertParams()![OU_CONSUMED]).toBe(0);
    expect(mockApplyOuConsumption).not.toHaveBeenCalled();
  });

  it('still bypasses for the vendors that can only be funded that way', async () => {
    // firecrawl has no platform key, so funding never varies and the row must
    // keep bypassing whatever the field says.
    await ingestEventWithBuckets(
      'account-1', 'evt-3', 0.1, template({ connector: 'firecrawl', webToolFunding: 'platform' }),
    );

    // 'platform' is meaningless for a vendor with no platform key, and the
    // runtime never sets it there. Asserted so a future vendor added to the
    // strict list cannot quietly start charging on a stray field.
    expect(insertParams()![OU_CONSUMED]).toBe(0);
    expect(insertParams()![COST_BUCKET]).toBe('unknown');
  });
});

describe('a workspace browsing on the PLATFORM key', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    mockApplyOuConsumption.mockResolvedValue([
      { ouConsumed: 42, costUsd: 0.42, customerCostUsd: 0.5, costBucket: 'included', sourceIdSuffix: '' },
    ]);
  });

  it('falls through to the customer-chargeable path', async () => {
    // We paid Browser Use for these hours, so the workspace owes us for them —
    // the same seam Composio, governance and embeddings already charge through.
    await ingestEventWithBuckets('account-1', 'evt-4', 0.42, template({ webToolFunding: 'platform' }));

    expect(mockApplyOuConsumption).toHaveBeenCalled();
    const p = insertParams();
    expect(p![OU_CONSUMED]).toBe(42);
    expect(p![CUSTOMER_COST]).toBe(0.5);
    expect(p![COST_BUCKET]).toBe('included');
  });
});

describe('Steel, the second vendor funded either way', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    mockApplyOuConsumption.mockResolvedValue([
      { ouConsumed: 7, costUsd: 0.07, customerCostUsd: 0.1, costBucket: 'included', sourceIdSuffix: '' },
    ]);
  });

  it("takes the bypass on a workspace's own key", async () => {
    await ingestEventWithBuckets('account-1', 'evt-5', 0.07, template({ connector: 'steel', webToolFunding: 'tenant_key' }));
    expect(mockApplyOuConsumption).not.toHaveBeenCalled();
    const p = insertParams();
    expect(p![COST_USD]).toBe(0.07);
    expect(p![OU_CONSUMED]).toBe(0);
    expect(p![CUSTOMER_COST]).toBe(0);
    expect(p![COST_BUCKET]).toBe('unknown');
  });

  it('charges the workspace for hours on the platform key', async () => {
    await ingestEventWithBuckets('account-1', 'evt-6', 0.07, template({ connector: 'steel', webToolFunding: 'platform' }));
    expect(mockApplyOuConsumption).toHaveBeenCalled();
    const p = insertParams();
    expect(p![OU_CONSUMED]).toBe(7);
    expect(p![CUSTOMER_COST]).toBe(0.1);
    expect(p![COST_BUCKET]).toBe('included');
  });
});

// Tavily and Exa are in the either-way set: the platform's keys
// for both are pay-as-you-go, so a team bound to neither reads and researches
// on our key and owes us the vendor's real charge, while a workspace on its
// own key still pays the vendor directly.
describe.each(['tavily', 'exa'])('%s, funded either way since the platform key became pay-as-you-go', (connector) => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    mockApplyOuConsumption.mockResolvedValue([
      { ouConsumed: 1, costUsd: 0.001, customerCostUsd: 0.002, costBucket: 'included', sourceIdSuffix: '' },
    ]);
  });

  it("takes the bypass on a workspace's own key, and when the row says nothing", async () => {
    for (const [id, over] of [['evt-7', { webToolFunding: 'tenant_key' as const }], ['evt-8', {}]] as const) {
      mockClientQuery.mockClear();
      await ingestEventWithBuckets('account-1', id, 0.001, template({ connector, actionType: 'web_research', ...over }));
      expect(mockApplyOuConsumption).not.toHaveBeenCalled();
      const p = insertParams();
      expect(p![COST_USD]).toBe(0.001);
      expect(p![OU_CONSUMED]).toBe(0);
      expect(p![CUSTOMER_COST]).toBe(0);
      expect(p![COST_BUCKET]).toBe('unknown');
    }
  });

  it('charges the workspace for a call on the platform key', async () => {
    await ingestEventWithBuckets('account-1', 'evt-9', 0.001, template({ connector, actionType: 'web_research', webToolFunding: 'platform' }));
    expect(mockApplyOuConsumption).toHaveBeenCalled();
    const p = insertParams();
    expect(p![OU_CONSUMED]).toBe(1);
    expect(p![CUSTOMER_COST]).toBe(0.002);
    expect(p![COST_BUCKET]).toBe('included');
  });
});
