const mockQuery = jest.fn();
jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockQuery })),
  closePool: jest.fn(),
}));

jest.mock('../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { logCostEvent } from '../cost-log';
import type { CostEvent } from '../types';

function makeCostEvent(partial: Partial<CostEvent> = {}): CostEvent {
  return {
    tenantId: 'tenant-1',
    connectorId: 'conn-1',
    connectorType: 'slack',
    entityType: 'Message',
    model: 'claude-haiku-4-5',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.0001,
    memoryType: 'CONVENTION',
    worthy: true,
    sourceRecordId: 'entity-1',
    messageId: 'msg-1',
    ...partial,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('logCostEvent', () => {
  it('inserts a row with all required fields including message_id', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await logCostEvent(makeCostEvent());
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO harvest_cost_events');
    expect(sql).toContain('ON CONFLICT (message_id, occurred_at) DO NOTHING');
    expect(params).toEqual([
      'tenant-1', 'conn-1', 'slack', 'Message',
      'claude-haiku-4-5', 100, 50, 0.0001,
      'CONVENTION', true, 'entity-1', 'msg-1',
    ]);
  });

  it('does NOT throw when pg query throws (error swallowed)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));
    await expect(logCostEvent(makeCostEvent())).resolves.toBeUndefined();
  });

  it('inserts message_id on every call (idempotency is handled by harvest_dedup, not ON CONFLICT)', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    await logCostEvent(makeCostEvent());
    await logCostEvent(makeCostEvent());
    expect(mockQuery).toHaveBeenCalledTimes(2);
    // Both calls include message_id as the last param.
    expect(mockQuery.mock.calls[0][1][11]).toBe('msg-1');
    expect(mockQuery.mock.calls[1][1][11]).toBe('msg-1');
  });
});
