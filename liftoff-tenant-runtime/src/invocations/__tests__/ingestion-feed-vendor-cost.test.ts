/**
 * The reconciliation feed must not reprice a gateway run from the rate snapshot.
 *
 * `listInvocationsForIngestion` is the BACKSTOP for the `invocation.completed`
 * event, and the event already carries the charge the gateway reported. The feed
 * recomputed cost from this row's tokens and rates, so the two paths disagreed by
 * up to the endpoint spread on a gateway model: one model is served by many
 * endpoints at different prices, `sync-model-pricing` resolves that with the max
 * across endpoints, and a run the event path missed was reconciled at the dearest
 * endpoint's rate. Migration 438 stores the charge; this pins that the feed
 * prefers it and still recomputes where there is none.
 */

import { jest } from '@jest/globals';

const queryMock = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>>();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: queryMock, connect: jest.fn() }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../observability/runtime-extensions-metrics', () => ({
  invocation_failed_total: { inc: jest.fn() },
}));
jest.mock('../../memory/metrics', () => ({ incCounter: jest.fn() }));

import { InvocationsService } from '../service';

/** One feed row. Tokens and rates are the real dev figures for a qwen3.7-plus
 *  turn, which the rate snapshot prices at $0.01052768. */
const row = (vendorCost: string | null, extra: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  agent_id: 'agent-1',
  internal_agent_id: null,
  thread_id: null,
  triggered_by: 'human',
  trigger_ref: null,
  provider: 'qwen',
  model_id: 'qwen/qwen3.7-plus',
  input_tokens: '32887',
  output_tokens: '3',
  cached_tokens: '0',
  input_price_per_million: '0.3200',
  output_price_per_million: '1.2800',
  cached_input_price_per_million: null,
  cache_write_tokens: null,
  cache_write_price_per_million: null,
  vendor_cost_usd: vendorCost,
  outcome: 'success',
  started_at: new Date('2026-09-26T06:53:20.826Z'),
  ...extra,
});

const feed = async (vendorCost: string | null, extra: Record<string, unknown> = {}) => {
  queryMock.mockResolvedValueOnce({ rows: [row(vendorCost, extra)] });
  const rows = await new InvocationsService().listInvocationsForIngestion('t-1', new Date(0), 500);
  return rows[0];
};

/** What the rate snapshot alone produces, to the precision the feed emits. */
const FROM_RATES = (32887 * 0.32 + 3 * 1.28) / 1_000_000;

describe('the ingestion feed and the gateway charge', () => {
  afterEach(() => queryMock.mockReset());

  it('reports the reported charge rather than recomputing it', async () => {
    const r = await feed('0.0182231800');
    expect(r.costUsd).toBeCloseTo(0.01822318, 10);
    // And it is emphatically NOT the snapshot's answer — that is the 42% gap.
    expect(r.costUsd).not.toBeCloseTo(FROM_RATES, 6);
  });

  it('still emits the rate snapshot unchanged, because those columns describe the model', async () => {
    const r = await feed('0.0182231800');
    expect(r.inputPricePerMillion).toBe(0.32);
    expect(r.outputPricePerMillion).toBe(1.28);
    expect(r.inputTokens).toBe(32887);
    expect(r.outputTokens).toBe(3);
  });

  it('recomputes from the rates when no charge was reported, which is every direct-API vendor', async () => {
    const r = await feed(null);
    expect(r.costUsd).toBeCloseTo(FROM_RATES, 10);
  });

  it('treats a stored zero as no charge rather than a free call', async () => {
    // A zero booked as a charge is an unbilled call. The column should never hold
    // one, and if it does the rates must still win.
    const r = await feed('0');
    expect(r.costUsd).toBeCloseTo(FROM_RATES, 10);
  });
});

describe('the ingestion feed and cache writes', () => {
  afterEach(() => queryMock.mockReset());

  it('charges the cache write at the rate the row was priced at', async () => {
    // Anthropic bills a write at 1.25x input. Recomputing without it is what let
    // the backstop under-charge every cache-heavy run on the dominant engine.
    const r = await feed(null, {
      provider: 'anthropic',
      model_id: 'claude-opus-5',
      cache_write_tokens: '4000000',
      cache_write_price_per_million: '6.250000',
    });
    // 4,000,000 at $6.25/M = $25.00, on top of the token charge.
    expect(r.costUsd! - FROM_RATES).toBeCloseTo(25.0, 6);
  });

  it('uses the ROW rate, not today\'s table, so the two billing paths agree', async () => {
    // The event path published a charge at the rate in force then. If this
    // recomputation reached for the current rate instead, the paths would differ
    // in exactly the cases nobody watches.
    const r = await feed(null, {
      provider: 'anthropic',
      model_id: 'claude-opus-5',
      cache_write_tokens: '1000000',
      cache_write_price_per_million: '99.000000',
    });
    expect(r.costUsd! - FROM_RATES).toBeCloseTo(99.0, 6);
  });

  it('adds nothing when the vendor publishes no cache-write rate', async () => {
    const r = await feed(null, { cache_write_tokens: '1000000', cache_write_price_per_million: null });
    expect(r.costUsd).toBeCloseTo(FROM_RATES, 10);
  });

  it('is superseded by a reported charge, like every other count', async () => {
    const r = await feed('0.0182231800', {
      cache_write_tokens: '4000000',
      cache_write_price_per_million: '6.250000',
    });
    expect(r.costUsd).toBeCloseTo(0.01822318, 10);
  });
});
