const mockQuery = jest.fn();
const mockIsExecutionAllowed = jest.fn();
const mockInsertAuditLog = jest.fn();

jest.mock('../../infrastructure/database', () => ({ getPoolForService: () => ({ query: mockQuery }) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../entitlements-client/service', () => ({
  isExecutionAllowed: (...a: unknown[]) => mockIsExecutionAllowed(...a),
}));
jest.mock('../../audit', () => ({ insertAuditLog: (...a: unknown[]) => mockInsertAuditLog(...a) }));

import { runIdempotencyReconciliation } from '../idempotency-reconciler';

const tid = '11111111-1111-1111-1111-111111111111';

describe('idempotency-reconciler (§4.8)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockIsExecutionAllowed.mockReset();
    mockInsertAuditLog.mockReset().mockResolvedValue(undefined);
    process.env.IDEMPOTENCY_RECONCILER_ENABLED = '1';
  });

  it('disabled flag → no-op (no DB touch)', async () => {
    process.env.IDEMPOTENCY_RECONCILER_ENABLED = '0';
    expect(await runIdempotencyReconciliation(tid)).toEqual({ abandoned: 0, pruned: 0, ledgerPruned: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('tenant not execution-allowed → skip', async () => {
    mockIsExecutionAllowed.mockResolvedValue(false);
    expect(await runIdempotencyReconciliation(tid)).toEqual({ abandoned: 0, pruned: 0, ledgerPruned: 0 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('abandons stuck at_most_once side-effect rows, audits each, prunes payloads + ledger', async () => {
    mockIsExecutionAllowed.mockResolvedValue(true);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'k1', entity_id: 'k1' }, { event_id: 'k2', entity_id: 'k2' }] }) // abandon sweep
      .mockResolvedValueOnce({ rowCount: 3 })  // payload prune
      .mockResolvedValueOnce({ rowCount: 5 }); // ledger prune
    const r = await runIdempotencyReconciliation(tid);
    expect(r).toEqual({ abandoned: 2, pruned: 3, ledgerPruned: 5 });
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(2);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/status='abandoned'/);
    expect(sql).toMatch(/event_type = 'side_effect'/);
    expect(sql).toMatch(/at_most_once/);
    expect(sql).toMatch(/status = 'processing'/);
  });

  it('ledger prune deletes only terminal rows older than 14 days, in a bounded batch', async () => {
    mockIsExecutionAllowed.mockResolvedValue(true);
    mockQuery
      .mockResolvedValueOnce({ rows: [] })     // abandon sweep (nothing stuck)
      .mockResolvedValueOnce({ rowCount: 0 })  // payload prune
      .mockResolvedValueOnce({ rowCount: 42 }); // ledger prune
    const r = await runIdempotencyReconciliation(tid);
    expect(r.ledgerPruned).toBe(42);
    const ledgerSql = mockQuery.mock.calls[2][0] as string;
    expect(ledgerSql).toMatch(/DELETE FROM event_processing_ledger/);
    expect(ledgerSql).toMatch(/status <> 'processing'/);      // never touches in-flight rows
    expect(ledgerSql).toMatch(/INTERVAL '14 days'/);          // retention window
    expect(ledgerSql).toMatch(/LIMIT 5000/);                  // batched, avoids long locks
  });

  it('abandon-sweep error is caught; prunes still run', async () => {
    mockIsExecutionAllowed.mockResolvedValue(true);
    mockQuery
      .mockRejectedValueOnce(new Error('boom'))  // abandon sweep throws
      .mockResolvedValueOnce({ rowCount: 0 })    // payload prune
      .mockResolvedValueOnce({ rowCount: 0 });   // ledger prune
    const r = await runIdempotencyReconciliation(tid);
    expect(r.abandoned).toBe(0);
    expect(r.pruned).toBe(0);
    expect(r.ledgerPruned).toBe(0);
  });

  it('ledger-prune error is caught and does not throw', async () => {
    mockIsExecutionAllowed.mockResolvedValue(true);
    mockQuery
      .mockResolvedValueOnce({ rows: [] })        // abandon sweep
      .mockResolvedValueOnce({ rowCount: 0 })     // payload prune
      .mockRejectedValueOnce(new Error('ledger boom')); // ledger prune throws
    const r = await runIdempotencyReconciliation(tid);
    expect(r).toEqual({ abandoned: 0, pruned: 0, ledgerPruned: 0 });
  });
});
