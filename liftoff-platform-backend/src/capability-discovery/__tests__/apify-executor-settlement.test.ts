// A per-result actor's charges land after its run is terminal. The cost read
// waits for them, bounded, and books what it saw when the wait runs out.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../vendor-gate', () => ({
  platformVendorSwitchedOffSync: jest.fn().mockReturnValue(false),
  isCooling: jest.fn().mockReturnValue(false),
  parkCredential: jest.fn().mockResolvedValue(undefined),
}));
// The float is not what this is about: no live token, and nothing bought, so
// every run here is the platform account's.
jest.mock('../../billing/apify-prepaid-token-service', () => ({
  getLiveApifyPrepaidToken: jest.fn().mockResolvedValue(null),
  refreshApifyPrepaidBalance: jest.fn().mockResolvedValue({ balanceUsd: null, retired: false }),
  ensureApifyPrepaidToken: jest.fn().mockResolvedValue({ purchased: false }),
  apifyPrepaidMinBalanceUsd: () => 0.1,
}));

import { log } from '../../infrastructure/logging';
import { _resetApifyPurchaseBackoff, runApifyActor } from '../apify-executor';

const realFetch = global.fetch;
const savedToken = process.env.APIFY_PLATFORM_TOKEN;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  _resetApifyPurchaseBackoff();
  process.env.APIFY_PLATFORM_TOKEN = 'apify_api_test';
});

afterEach(() => {
  jest.useRealTimers();
  global.fetch = realFetch;
  if (savedToken === undefined) delete process.env.APIFY_PLATFORM_TOKEN;
  else process.env.APIFY_PLATFORM_TOKEN = savedToken;
});

const ACTOR = 'clearpath/reddit-subreddit-posts-scraper';

/** A fetch whose reads of the run return `runReads` in order (the last one
 *  repeating), so a test can script how the vendor's accounting catches up. */
function fetchWithRunReads(runReads: Array<Record<string, unknown>>, items: unknown[]) {
  let reads = 0;
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (init?.method === 'POST') {
      return ok({ data: { id: 'run-1', status: 'SUCCEEDED', ...runReads[0] } });
    }
    if (url.includes('/actor-runs/run-1/dataset/items')) return ok(items);
    if (url.endsWith('/actor-runs/run-1')) {
      const body = runReads[Math.min(reads, runReads.length - 1)];
      reads += 1;
      return ok({ data: { id: 'run-1', status: 'SUCCEEDED', ...body } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return Object.assign(fn, { runReads: () => reads });
}

/** Drive the executor through its settlement polls. */
async function settle<T>(p: Promise<T>, polls: number): Promise<T> {
  for (let i = 0; i < polls; i++) {
    await jest.advanceTimersByTimeAsync(2_000);
  }
  return p;
}

const PPE = { pricingInfo: { pricingModel: 'PAY_PER_EVENT' } };

describe('the settlement read', () => {
  it('waits for a per-result run’s charges to land and books the settled figure', async () => {
    const fetchMock = fetchWithRunReads(
      [
        { ...PPE, usageTotalUsd: 0.0005, chargedEventCounts: { 'apify-actor-start': 1, 'post-scraped': 0 } },
        { ...PPE, usageTotalUsd: 0.0005, chargedEventCounts: { 'apify-actor-start': 1, 'post-scraped': 5 } },
        { ...PPE, usageTotalUsd: 0.0105, chargedEventCounts: { 'apify-actor-start': 1, 'post-scraped': 5 } },
      ],
      [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e' }],
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const run = await settle(runApifyActor(ACTOR, { subreddit: 'x' }), 3);

    expect(run).toMatchObject({ success: true, costUsd: 0.0105, runId: 'run-1' });
    expect(fetchMock.runReads()).toBe(3);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'apify_run_cost_settled_late', runId: 'run-1', carriedUsd: 0.0005, settledUsd: 0.0105 }),
      expect.any(String),
    );
  });

  it('does not count the start event as a charged result', async () => {
    // Counts show only the start fee; the dollars have not moved. Still waiting.
    const fetchMock = fetchWithRunReads(
      [
        { ...PPE, usageTotalUsd: 0.0005, chargedEventCounts: { 'apify-actor-start': 1 } },
        { ...PPE, usageTotalUsd: 0.0005, chargedEventCounts: { 'apify-actor-start': 1 } },
        { ...PPE, usageTotalUsd: 0.0025, chargedEventCounts: { 'apify-actor-start': 1, 'result': 2 } },
      ],
      [{}, {}],
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const run = await settle(runApifyActor(ACTOR, {}), 3);
    expect(run.costUsd).toBe(0.0025);
    expect(fetchMock.runReads()).toBe(3);
  });

  it('books the figure as it stands, and says so, when the charges have not landed within the wait', async () => {
    const fetchMock = fetchWithRunReads(
      [{ ...PPE, usageTotalUsd: 0.0005, chargedEventCounts: { 'apify-actor-start': 1, 'post-scraped': 0 } }],
      [{ title: 'a' }],
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const run = await settle(runApifyActor(ACTOR, {}), 10);

    expect(run).toMatchObject({ success: true, costUsd: 0.0005, runId: 'run-1' });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'apify_run_cost_unsettled', runId: 'run-1', waitedMs: 15_000 }),
      expect.any(String),
    );
    // Bounded: the wait is 15 s at 2 s per poll, never more.
    expect(fetchMock.runReads()).toBeLessThanOrEqual(9);
  });

  it('reads once and books immediately for an actor that does not charge per result', async () => {
    const fetchMock = fetchWithRunReads(
      [{ pricingInfo: { pricingModel: 'FLAT_PRICE_PER_MONTH' }, usageTotalUsd: 0.002 }],
      [{ title: 'a' }],
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const run = await runApifyActor(ACTOR, {});
    expect(run.costUsd).toBe(0.002);
    expect(fetchMock.runReads()).toBe(1);
  });

  it('reads once for a per-result run that returned nothing: there is nothing to settle', async () => {
    const fetchMock = fetchWithRunReads([{ ...PPE, usageTotalUsd: 0.0005 }], []);
    global.fetch = fetchMock as unknown as typeof fetch;
    const run = await runApifyActor(ACTOR, {});
    expect(run.costUsd).toBe(0.0005);
    expect(fetchMock.runReads()).toBe(1);
  });

  it('starts every run with the per-run charge cap and the item cap', async () => {
    const fetchMock = fetchWithRunReads([{ usageTotalUsd: 0.001 }], []);
    global.fetch = fetchMock as unknown as typeof fetch;
    await runApifyActor(ACTOR, {});
    const start = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(start?.[0]).toContain('maxItems=100');
    expect(start?.[0]).toContain('maxTotalChargeUsd=1');
  });
});
