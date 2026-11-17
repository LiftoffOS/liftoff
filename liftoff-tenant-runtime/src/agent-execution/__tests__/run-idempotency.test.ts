const mockQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: mockQuery }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { claimAgentRun, completeAgentRun, failAgentRun } from '../run-idempotency';

describe('run-idempotency (§4.7) — claimAgentRun', () => {
  const base = { tenantId: '11111111-1111-1111-1111-111111111111', triggerKey: 'evt-abc' };
  beforeEach(() => mockQuery.mockReset());

  it('first delivery → run (INSERT claims the row)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'processing' }] });
    await expect(claimAgentRun(base)).resolves.toEqual({ outcome: 'run' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('failed row → run (ON CONFLICT resets failed → processing and RETURNs)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'processing' }] });
    await expect(claimAgentRun(base)).resolves.toEqual({ outcome: 'run' });
  });

  it('completed → replay the full result from the side table', async () => {
    const cached = { success: true, toolCallsExecuted: 2, reasoningSteps: 3, output: 'big-output' };
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // INSERT excluded by WHERE
      .mockResolvedValueOnce({ rows: [{ status: 'completed', result_metadata: { success: true } }] }) // status
      .mockResolvedValueOnce({ rows: [{ payload: cached }] }); // loadRunResult (side table)
    await expect(claimAgentRun(base)).resolves.toEqual({ outcome: 'replay', result: cached });
  });

  it('completed but no stored payload/metadata → replay a default success result', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'completed', result_metadata: null }] })
      .mockResolvedValueOnce({ rows: [] }); // loadRunResult empty
    await expect(claimAgentRun(base)).resolves.toEqual({
      outcome: 'replay',
      result: { success: true, toolCallsExecuted: 0, reasoningSteps: 0 },
    });
  });

  it('active processing (<5 min) → skip (another delivery owns it)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: 'processing', result_metadata: null }] });
    await expect(claimAgentRun(base)).resolves.toEqual({ outcome: 'skip' });
  });

  it('row vanished between the two queries → run (safe)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(claimAgentRun(base)).resolves.toEqual({ outcome: 'run' });
  });

  it('fail-open: any DB error → run (never block a real run)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(claimAgentRun(base)).resolves.toEqual({ outcome: 'run' });
  });
});

describe('run-idempotency (§4.7) — complete/fail', () => {
  const base = { tenantId: '11111111-1111-1111-1111-111111111111', triggerKey: 'evt-abc' };
  beforeEach(() => mockQuery.mockReset());

  it('completeAgentRun stores full result in side table + compact in result_metadata (<4096)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await completeAgentRun({
      ...base,
      result: { success: true, toolCallsExecuted: 5, reasoningSteps: 4, output: 'x'.repeat(99999) },
    });
    expect(mockQuery.mock.calls[0][0]).toMatch(/idempotency_result_payloads/);
    expect((JSON.parse(mockQuery.mock.calls[0][1][2] as string).output as string).length).toBe(99999); // full
    expect(mockQuery.mock.calls[1][0]).toMatch(/status='completed'/);
    const meta = JSON.parse(mockQuery.mock.calls[1][1][2] as string);
    expect(meta).toEqual({ success: true, toolCallsExecuted: 5, reasoningSteps: 4 }); // compact
    expect((mockQuery.mock.calls[1][1][2] as string).length).toBeLessThan(4096);
  });

  it('completeAgentRun preserves paused/escalated flags in the compact metadata', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await completeAgentRun({
      ...base,
      result: { success: false, toolCallsExecuted: 1, reasoningSteps: 1, escalated: true, paused: true },
    });
    const meta = JSON.parse(mockQuery.mock.calls[1][1][2] as string);
    expect(meta).toEqual({ success: false, toolCallsExecuted: 1, reasoningSteps: 1, escalated: true, paused: true });
  });

  it('failAgentRun marks failed with a truncated (≤1024) error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await failAgentRun({ ...base, error: 'e'.repeat(5000) });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/status='failed'/);
    expect((params[2] as string).length).toBe(1024);
  });

  it('complete/fail swallow DB errors (non-fatal)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(completeAgentRun({ ...base, result: { success: true, toolCallsExecuted: 0, reasoningSteps: 0 } })).resolves.toBeUndefined();
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(failAgentRun({ ...base, error: 'boom' })).resolves.toBeUndefined();
  });
});
