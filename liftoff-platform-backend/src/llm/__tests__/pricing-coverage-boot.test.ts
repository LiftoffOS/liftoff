// The boot-time coverage check reports, and never takes the process down.
//
// Its sibling src/llm/__tests__/pricing-coverage.test.ts ratchets the CODE
// table. This covers the half that one structurally cannot see: a model becomes
// reachable by a row in `models` with status 'approved', which is a database
// fact, and the unit suite has no database. What is asserted here is the
// decision the checker makes given rows, and that a failure to ask is reported
// as not knowing rather than as an answer.

import { pricingCoverage, reportPricingCoverageAtBoot } from '../pricing-coverage';
import { pricingKeysFor } from '../pricing';
import { log } from '../../infrastructure/logging';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** A pool that answers the two queries in the order the checker issues them. */
function poolWith(approved: Array<[string, string]>, priced: Array<[string, string]>) {
  return {
    query: jest.fn((sql: string) => {
      const rows = sql.includes('FROM models')
        ? approved.map(([provider, model_id]) => ({ provider, model_id }))
        : priced.map(([provider, model_id]) => ({ provider, model_id }));
      return Promise.resolve({ rows });
    }),
  } as never;
}

beforeEach(() => jest.clearAllMocks());

describe('pricingCoverage', () => {
  it('finds an approved model with no rate anywhere', async () => {
    const pool = poolWith([['acme', 'acme-unpriced-1']], []);
    const { approved, unpriced } = await pricingCoverage(pool);
    expect(approved).toBe(1);
    expect(unpriced).toEqual(['acme:acme-unpriced-1']);
  });

  it('counts a model priced in the DATABASE as covered', async () => {
    // The database is the live half. A rate recorded there is a rate, whether
    // or not the code table has heard of the model.
    const pool = poolWith([['acme', 'acme-unpriced-1']], [['acme', 'acme-unpriced-1']]);
    expect((await pricingCoverage(pool)).unpriced).toEqual([]);
  });

  it('counts a model priced only in CODE as covered', async () => {
    // MODEL_PRICING is the fallback that applies offline, on a first boot and
    // after a failed refresh, so a model in it is priced even with no row.
    //
    // pricingKeysFor is what reconciles the two shapes and is why this is not a
    // string comparison: MODEL_PRICING is keyed by BARE model id, the database
    // by (provider, model_id), and a lookup that knew only one of those would
    // report every code-priced model as unpriced.
    const pool = poolWith([['anthropic', 'claude-fable-5-2']], []);
    expect(pricingKeysFor('anthropic', 'claude-fable-5-2')).toContain('claude-fable-5-2');
    expect((await pricingCoverage(pool)).unpriced).toEqual([]);
  });
});

describe('reportPricingCoverageAtBoot', () => {
  it('logs an error naming every unpriced model', async () => {
    await reportPricingCoverageAtBoot(poolWith([['acme', 'acme-unpriced-1']], []));
    expect(log.error).toHaveBeenCalledTimes(1);
    const [fields] = (log.error as jest.Mock).mock.calls[0];
    expect(fields.event).toBe('model_pricing_missing');
    expect(fields.models).toEqual(['acme:acme-unpriced-1']);
  });

  it('says so plainly when everything is priced', async () => {
    await reportPricingCoverageAtBoot(poolWith([], []));
    expect(log.error).not.toHaveBeenCalled();
    expect((log.info as jest.Mock).mock.calls[0][0].unpricedModels).toBe(0);
  });

  it('does not throw when the database cannot answer', async () => {
    // Boot order is not guaranteed: the table may not exist yet because the
    // migrations have not run. An unanswerable question must not take the
    // process down, and must not be reported as "everything is fine" either.
    const pool = { query: jest.fn().mockRejectedValue(new Error('relation "models" does not exist')) } as never;
    await expect(reportPricingCoverageAtBoot(pool)).resolves.toBeUndefined();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect((log.warn as jest.Mock).mock.calls[0][0].event).toBe('model_pricing_coverage_unavailable');
  });
});
