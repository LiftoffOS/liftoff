const mockQuery = jest.fn();
const mockPublish = jest.fn();
const mockCalculateCost = jest.fn();

jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => ({ query: mockQuery }) }));
jest.mock('../../infrastructure/pubsub', () => ({ publisher: { publish: (...a: unknown[]) => mockPublish(...a) } }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../llm/pricing', () => ({ calculateCost: (...a: unknown[]) => mockCalculateCost(...a) }));

import { reconcileStalledBilling } from '../stalled-run-billing-reconciler';

const tid = '11111111-1111-1111-1111-111111111111';
const started = new Date('2026-04-09T00:00:00.000Z');
// Deliberately DIFFERENT from started_at: a conditional rate can be scoped to a
// UTC window, so a row must be priced against when the CALL happened, not when
// the run began. Same value, and the two would agree by accident.
const callAt = new Date('2026-04-09T17:45:00.000Z');

function metaRow(over: Record<string, unknown> = {}) {
  return {
    id: 'inv1',
    agent_id: 'a1',
    thread_id: 't1',
    triggered_by: 'cron',
    trigger_ref: null,
    started_at: started,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    in_tok: '1000',
    out_tok: '200',
    cached_tok: '0',
    ts: callAt,
    ...over,
  };
}

describe('stalled-run-billing-reconciler (ADR-031 fast-follow)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockPublish.mockReset().mockResolvedValue(undefined);
    mockCalculateCost.mockReset();
    process.env.STALLED_RUN_RECONCILER_ENABLED = '1';
    process.env.ENVIRONMENT = 'dev';
  });

  it('disabled flag → no-op (no DB, no publish)', async () => {
    process.env.STALLED_RUN_RECONCILER_ENABLED = '0';
    expect(await reconcileStalledBilling(tid)).toEqual({ drained: 0, costUsd: 0, cleaned: 0, unpriceable: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('bulk-settles zero-spend pending in one statement and drains nothing', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 7321 }) // bulk cleanup
      .mockResolvedValueOnce({ rows: [] }); // batch: nothing left with spend
    const r = await reconcileStalledBilling(tid);
    expect(r).toEqual({ drained: 0, costUsd: 0, cleaned: 7321, unpriceable: 0 });
    expect(mockPublish).not.toHaveBeenCalled();
    // cleanup statement excludes anything with billable llm_usage_log tokens
    expect(mockQuery.mock.calls[0][0]).toMatch(/reconciliation_status = 'reconciled'/);
    expect(mockQuery.mock.calls[0][0]).toMatch(/input_tokens > 0 OR l\.output_tokens > 0/);
  });

  it('prices each usage row SEPARATELY, never the summed tokens', async () => {
    // The reconciler used to SUM llm_usage_log per (provider, model) in SQL and
    // price the sums once. That is unsafe now that rates carry prompt-token
    // bands: 60 calls of 5,000 tokens sum to 300,000 and would be charged a
    // 200,000 long-context band that not one call came near — over-charging for
    // a band no request justifies. Three calls here must produce THREE pricing
    // calls at 5,000 each, not one at 15,000.
    const rows = [0, 1, 2].map((i) =>
      metaRow({ in_tok: '5000', out_tok: '100', ts: new Date(callAt.getTime() + i * 1000) }),
    );
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({});
    mockCalculateCost.mockReturnValue({ costUsd: 0.001, inputPricePerMillion: 1, outputPricePerMillion: 5 });

    const r = await reconcileStalledBilling(tid);

    expect(mockCalculateCost).toHaveBeenCalledTimes(3);
    for (const call of mockCalculateCost.mock.calls) {
      expect(call[2]).toBe(5000); // each priced on its OWN prompt size
    }
    // Cost still sums across the rows, so the drained figure is unchanged.
    expect(r.costUsd).toBeCloseTo(0.003, 10);
    // And the backfilled token totals are still the run-wide sums.
    const [, event] = mockPublish.mock.calls[0];
    expect(event).toMatchObject({ inputTokens: 15000, outputTokens: 300 });
  });

  it('falls back to started_at only when a usage row carries no timestamp', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [metaRow({ ts: null })] })
      .mockResolvedValueOnce({});
    mockCalculateCost.mockReturnValue({ costUsd: 0.01, inputPricePerMillion: 1, outputPricePerMillion: 5 });
    await reconcileStalledBilling(tid);
    expect(mockCalculateCost).toHaveBeenCalledWith('claude-haiku-4-5', 'anthropic', 1000, 200, 0, { at: started });
  });

  it('drains a spend-bearing invocation: publishes exact summed cost + backfills tokens + reconciled', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 }) // cleanup
      .mockResolvedValueOnce({ rows: [metaRow()] }) // batch (1 invocation, 1 model)
      .mockResolvedValueOnce({}); // UPDATE reconciled
    mockCalculateCost.mockReturnValue({ costUsd: 0.0123, inputPricePerMillion: 1, outputPricePerMillion: 5 });

    const r = await reconcileStalledBilling(tid);

    expect(r).toEqual({ drained: 1, costUsd: 0.0123, cleaned: 0, unpriceable: 0 });
    expect(mockCalculateCost).toHaveBeenCalledWith('claude-haiku-4-5', 'anthropic', 1000, 200, 0, { at: callAt });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [topic, event] = mockPublish.mock.calls[0];
    expect(topic).toBe('projects/YOUR_CONTROL_PROJECT_STAGING/topics/invocation-completed-dev');
    expect(event).toMatchObject({
      tenantId: tid,
      invocationId: 'inv1',
      agentId: 'a1',
      costUsd: 0.0123,
      isReconciliation: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 0,
      occurredAt: started.toISOString(),
    });
    // token columns backfilled + settled
    const settle = mockQuery.mock.calls[2];
    expect(settle[0]).toMatch(/reconciliation_status = 'reconciled'/);
    expect(settle[1]).toEqual(['inv1', 1000, 200, 0]);
  });

  it('multi-model invocation: sums cost across all (provider,model) groups; dominant model recorded', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          metaRow({ provider: 'anthropic', model: 'claude-sonnet-5', in_tok: '5000', out_tok: '400', cached_tok: '100' }),
          metaRow({ provider: 'anthropic', model: 'claude-haiku-4-5', in_tok: '1000', out_tok: '50', cached_tok: '0' }),
        ],
      })
      .mockResolvedValueOnce({});
    mockCalculateCost
      .mockReturnValueOnce({ costUsd: 0.05 }) // sonnet
      .mockReturnValueOnce({ costUsd: 0.002 }); // haiku

    const r = await reconcileStalledBilling(tid);

    expect(r.drained).toBe(1);
    expect(r.costUsd).toBeCloseTo(0.052, 6);
    const [, event] = mockPublish.mock.calls[0];
    expect(event.costUsd).toBeCloseTo(0.052, 6);
    expect(event.inputTokens).toBe(6000); // summed
    expect(event.outputTokens).toBe(450);
    expect(event.cachedTokens).toBe(100);
    expect(event.model).toBe('claude-sonnet-5'); // dominant by input tokens
  });

  it('unpriceable model → marks unrecoverable, never publishes (no silent under-drain)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [metaRow({ model: 'some-unknown-model' })] })
      .mockResolvedValueOnce({}); // UPDATE unrecoverable
    mockCalculateCost.mockReturnValue(null); // no pricing

    const r = await reconcileStalledBilling(tid);

    expect(r).toEqual({ drained: 0, costUsd: 0, cleaned: 0, unpriceable: 1 });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls[2][0]).toMatch(/reconciliation_status = 'unrecoverable'/);
  });

  it('publish failure → invocation stays pending (not marked)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [metaRow()] });
    mockCalculateCost.mockReturnValue({ costUsd: 0.01 });
    mockPublish.mockRejectedValue(new Error('pubsub down'));

    const r = await reconcileStalledBilling(tid);

    expect(r).toEqual({ drained: 0, costUsd: 0, cleaned: 0, unpriceable: 0 });
    // only cleanup + batch select ran; no settle UPDATE after failed publish
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
