/**
 * Phase 2 PB-3 of the deep-research-realtime-billing plan.
 *
 * Negative rawCostUsd now routes through ingestEventWithBuckets's refund
 * branch, which:
 *   1. calls applyOuRefund (decrements counter, dedup-aware)
 *   2. inserts a SINGLE cost_attribution_events row with cost_bucket='reload'
 *      and negative cost_usd / ou_consumed / customer_cost_usd
 *
 * Zero remains a no-op. Positive costs continue through the existing
 * applyOuConsumption + bucket-split path.
 */

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock the database wrapper so we capture the callback's PoolClient.
const mockClientQuery = jest.fn();
const mockClient = { query: mockClientQuery, release: jest.fn() };
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) => fn(mockClient)),
  withTenantScope: jest.fn(),
  getPool: jest.fn(),
}));

// Mock the OU helpers so we don't reach Postgres for rate lookups.
const mockApplyOuConsumption = jest.fn();
const mockApplyOuRefund = jest.fn();
const mockGetOuDefinitionRateUsd = jest.fn();
jest.mock('../ou-bucket-service', () => ({
  applyOuConsumption: (...a: unknown[]) => mockApplyOuConsumption(...a),
  applyOuRefund:      (...a: unknown[]) => mockApplyOuRefund(...a),
  getOuDefinitionRateUsd: (...a: unknown[]) => mockGetOuDefinitionRateUsd(...a),
}));

// applyReloadDrain is invoked from the customer-chargeable path; stub to a
// no-op so we don't reach reload-balance machinery.
jest.mock('../reload-drain', () => ({
  applyReloadDrain: jest.fn().mockResolvedValue(undefined),
}));

// classifyChargeability: default to 'customer' so the customer + refund
// branches are exercised.
jest.mock('../event-classification', () => ({
  classifyChargeability: jest.fn().mockReturnValue('customer'),
}));

import { ingestEventWithBuckets } from '../repository';
import type { CostAttributionEvent } from '../types';

const ACCOUNT_ID = 'acct-1';
const TENANT_ID = 'tenant-1';

const TEMPLATE: Omit<CostAttributionEvent, 'sourceId' | 'costUsd' | 'ouConsumed' | 'customerCostUsd' | 'costBucket'> = {
  tenantId:   TENANT_ID,
  agentId:    'agent-1',
  workflowId: null,
  actionId:   null,
  eventType:  'web_tool',
  source:     'tenant_runtime',
  connector:  'perplexity',
  actionType: 'web_deep_research',
  occurredAt: new Date('2026-06-02T00:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('ingestEventWithBuckets — refund branch (PB-3)', () => {
  it('routes negative rawCostUsd through applyOuRefund and writes one row with cost_bucket=reload', async () => {
    mockApplyOuRefund.mockResolvedValueOnce({ ouRefunded: 3000, customerCreditUsd: 0.30 });
    const inserted = await ingestEventWithBuckets(
      ACCOUNT_ID,
      'deep-research-id-1/delta',
      -0.30,                                  // signed delta = refund
      TEMPLATE,
    );
    expect(inserted).toBe(1);
    expect(mockApplyOuRefund).toHaveBeenCalledTimes(1);
    expect(mockApplyOuRefund.mock.calls[0][1]).toBe(ACCOUNT_ID);
    expect(mockApplyOuRefund.mock.calls[0][2]).toBeCloseTo(0.30);   // Math.abs

    // Inspect the INSERT — should land cost_bucket='reload', negative
    // cost_usd / ou_consumed / customer_cost_usd, source_id WITHOUT bucket
    // suffix.
    const insertCalls = mockClientQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO cost_attribution_events'),
    );
    expect(insertCalls.length).toBe(1);
    const params = insertCalls[0][1] as unknown[];
    // Column order in the plan: tenant_id, agent_id, workflow_id, action_id,
    // thread_id, invocation_id, parent_invocation_id, connector, entity_type,
    // action_type, purpose, event_type, source, source_id, provider, model,
    // input_tokens, output_tokens, cached_tokens, cost_usd, hosting_mode,
    // correlation_confidence, occurred_at, ou_consumed, customer_cost_usd,
    // cost_bucket, item_id.
    expect(params[13]).toBe('deep-research-id-1/delta');             // source_id — NO bucket suffix
    expect(params[19]).toBe(-0.30);                                  // cost_usd (negative)
    expect(params[23]).toBeCloseTo(-3000);                           // ou_consumed (negative)
    expect(params[24]).toBeCloseTo(-0.30);                           // customer_cost_usd (negative)
    expect(params[25]).toBe('reload');                               // cost_bucket
  });

  it('returns 0 (no row written) when applyOuRefund returns null (dedup hit / unprovisioned tenant)', async () => {
    mockApplyOuRefund.mockResolvedValueOnce(null);
    const inserted = await ingestEventWithBuckets(ACCOUNT_ID, 'deep-research-id-2/delta', -0.10, TEMPLATE);
    expect(inserted).toBe(0);
    const insertCalls = mockClientQuery.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO cost_attribution_events'),
    );
    expect(insertCalls.length).toBe(0);
  });

  it('zero rawCostUsd is a no-op (early return)', async () => {
    const inserted = await ingestEventWithBuckets(ACCOUNT_ID, 'noop-1', 0, TEMPLATE);
    expect(inserted).toBe(0);
    expect(mockApplyOuRefund).not.toHaveBeenCalled();
    expect(mockApplyOuConsumption).not.toHaveBeenCalled();
  });

  it('positive rawCostUsd does NOT trigger applyOuRefund — uses applyOuConsumption', async () => {
    mockApplyOuConsumption.mockResolvedValueOnce([{
      ouConsumed: 100, costUsd: 0.01, customerCostUsd: 0.01,
      costBucket: 'reload' as const, sourceIdSuffix: '',
    }]);
    await ingestEventWithBuckets(ACCOUNT_ID, 'positive-1', 0.01, TEMPLATE);
    expect(mockApplyOuRefund).not.toHaveBeenCalled();
    expect(mockApplyOuConsumption).toHaveBeenCalledTimes(1);
  });
});
