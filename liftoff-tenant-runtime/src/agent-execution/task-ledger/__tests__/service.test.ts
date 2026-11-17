const mockQuery = jest.fn();
jest.mock('../../../infrastructure/database', () => ({ getPoolForService: () => ({ query: mockQuery }) }));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { writeTaskLedger, getOpenTaskLedger, renderTaskLedgerBlock } from '../service';

const base = { tenantId: '11111111-1111-1111-1111-111111111111', agentId: '22222222-2222-2222-2222-222222222222' };

describe('task-ledger (§4.9 Part B)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('writeTaskLedger upserts each item (ON CONFLICT by tenant/agent/seq)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await writeTaskLedger({ ...base, items: [
      { seq: 1, text: 'a', status: 'pending' },
      { seq: 2, text: 'b', status: 'in_progress', note: 'n' },
    ] });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toMatch(/ON CONFLICT \(tenant_id, agent_id, seq\) DO UPDATE/);
  });

  it('writeTaskLedger is a no-op on empty items', async () => {
    await writeTaskLedger({ ...base, items: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('getOpenTaskLedger maps rows (note omitted when null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { seq: 1, text: 'a', status: 'pending', note: null },
      { seq: 2, text: 'b', status: 'in_progress', note: 'x' },
    ] });
    expect(await getOpenTaskLedger(base.tenantId, base.agentId)).toEqual([
      { seq: 1, text: 'a', status: 'pending' },
      { seq: 2, text: 'b', status: 'in_progress', note: 'x' },
    ]);
  });

  it('getOpenTaskLedger fail-open → []', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db'));
    expect(await getOpenTaskLedger(base.tenantId, base.agentId)).toEqual([]);
  });

  it('renderTaskLedgerBlock returns "" when empty (block omitted entirely)', () => {
    expect(renderTaskLedgerBlock([])).toBe('');
  });

  it('renderTaskLedgerBlock renders a checklist with status markers + notes', () => {
    const b = renderTaskLedgerBlock([
      { seq: 1, text: 'do x', status: 'pending' },
      { seq: 2, text: 'do y', status: 'in_progress', note: 'wip' },
    ]);
    expect(b).toMatch(/## Task Ledger/);
    expect(b).toContain('[ ] (#1) do x');
    expect(b).toContain('[~] (#2) do y  — wip');
  });
});
