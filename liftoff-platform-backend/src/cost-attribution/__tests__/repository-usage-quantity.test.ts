/**
 * usage_quantity across a bucket split.
 *
 * An event that crosses an OU bucket boundary becomes 2-3 ledger rows, each with
 * its own prorated slice of cost_usd. The vendor-native quantity has to be split
 * the same way. Writing the whole quantity on every row makes SUM(usage_quantity)
 * report 2-3x the audio that was actually transcribed — and that sum is the
 * number a vendor-invoice reconciliation compares against, so the error would
 * surface as a phantom discrepancy with the vendor rather than as a crash.
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
  eventType: 'voice_stt',
  source: 'platform_llm',
  provider: 'google',
  model: 'long',
  purpose: 'voice_dictation',
  usageQuantity: 60,
  usageUnit: 'audio_seconds',
  occurredAt: new Date('2026-08-05T00:00:00Z'),
  ...over,
});

/** usage_quantity is the second-to-last bound parameter on the insert. */
function insertedQuantities(): unknown[] {
  return mockClientQuery.mock.calls
    .filter((call) => String(call[0]).includes('INSERT INTO cost_attribution_events'))
    .map((call) => (call[1] as unknown[])[27]);
}

describe('usage_quantity on bucket-split rows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClientQuery.mockResolvedValue({ rowCount: 1, rows: [] });
  });

  it('keeps the whole quantity when the event lands in one bucket', async () => {
    mockApplyOuConsumption.mockResolvedValue([
      { ouConsumed: 1, costUsd: 0.96, customerCostUsd: 1, costBucket: 'included', sourceIdSuffix: '' },
    ]);

    await ingestEventWithBuckets('account-1', 'voice-stt:req-1', 0.96, template());

    expect(insertedQuantities()).toEqual([60]);
  });

  it('splits the quantity in the same proportion as the cost', async () => {
    // 75/25 cost split -> 45s/15s of the 60s utterance.
    mockApplyOuConsumption.mockResolvedValue([
      { ouConsumed: 0.75, costUsd: 0.72, customerCostUsd: 0.75, costBucket: 'included', sourceIdSuffix: '/included' },
      { ouConsumed: 0.25, costUsd: 0.24, customerCostUsd: 0.25, costBucket: 'precommit', sourceIdSuffix: '/precommit' },
    ]);

    await ingestEventWithBuckets('account-1', 'voice-stt:req-2', 0.96, template());

    const quantities = insertedQuantities() as number[];
    expect(quantities).toHaveLength(2);
    expect(quantities[0]).toBeCloseTo(45, 6);
    expect(quantities[1]).toBeCloseTo(15, 6);
    // The invariant that matters: the parts sum to the whole.
    expect(quantities[0] + quantities[1]).toBeCloseTo(60, 6);
  });

  it('sums to the original across a three-way split', async () => {
    mockApplyOuConsumption.mockResolvedValue([
      { ouConsumed: 0.5, costUsd: 0.48, customerCostUsd: 0.5, costBucket: 'included', sourceIdSuffix: '/included' },
      { ouConsumed: 0.3, costUsd: 0.288, customerCostUsd: 0.3, costBucket: 'precommit', sourceIdSuffix: '/precommit' },
      { ouConsumed: 0.2, costUsd: 0.192, customerCostUsd: 0.2, costBucket: 'reload', sourceIdSuffix: '/reload' },
    ]);

    await ingestEventWithBuckets('account-1', 'voice-stt:req-3', 0.96, template());

    const quantities = insertedQuantities() as number[];
    expect(quantities).toHaveLength(3);
    expect(quantities.reduce((a, b) => a + b, 0)).toBeCloseTo(60, 6);
  });

  it('leaves the column null for events that report no usage', async () => {
    mockApplyOuConsumption.mockResolvedValue([
      { ouConsumed: 1, costUsd: 0.5, customerCostUsd: 1, costBucket: 'included', sourceIdSuffix: '' },
    ]);

    await ingestEventWithBuckets(
      'account-1',
      'llm:req-4',
      0.5,
      template({ eventType: 'llm_invocation', usageQuantity: undefined, usageUnit: undefined }),
    );

    expect(insertedQuantities()).toEqual([null]);
  });
});
