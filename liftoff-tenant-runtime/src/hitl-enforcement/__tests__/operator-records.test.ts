/**
 * B4: the operator view of `system_internal` escalations.
 *
 * These records left every customer surface when the review queue narrowed to
 * parked runs, which was right, and left them visible to nobody at all: the
 * internal dashboard reads the control-plane database and never called the
 * runtime. The listing below is the read path that fixes that, and the property
 * that matters most is what it refuses to return.
 */
const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
  withTenantScope: jest.fn(),
  getPool: () => ({ query: (...args: unknown[]) => queryMock(...args) }),
  getPoolForService: () => ({ query: (...args: unknown[]) => queryMock(...args) }),
}));

import { HitlEnforcementService } from '../service';

const service = new HitlEnforcementService();

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('listOperatorRecords', () => {
  it('returns system_internal records only', async () => {
    // A customer-facing escalation parks its run and belongs in the review
    // queue. Listing one here would rebuild the dumping ground this whole
    // change removed.
    await service.listOperatorRecords({ tenantId: 't' });

    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toContain("kind = 'system_internal'");
    expect(sql).not.toMatch(/kind = 'escalation'/);
  });

  it('scopes to the calling tenant', async () => {
    await service.listOperatorRecords({ tenantId: 't' });

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('tenant_id = $1');
    expect(params[0]).toBe('t');
  });

  it('filters by status when asked, and does not when not', async () => {
    await service.listOperatorRecords({ tenantId: 't', status: 'pending' });
    expect((queryMock.mock.calls[0][1] as unknown[])[1]).toBe('pending');

    queryMock.mockClear();
    await service.listOperatorRecords({ tenantId: 't' });
    // NULL makes the predicate a no-op rather than matching a literal 'null'.
    expect((queryMock.mock.calls[0][1] as unknown[])[1]).toBeNull();
  });

  it('shows the newest first, because an operator triages what just broke', async () => {
    await service.listOperatorRecords({ tenantId: 't' });
    expect(queryMock.mock.calls[0][0] as string).toContain('ORDER BY created_at DESC');
  });

  it('bounds the page so one tenant cannot return the table', async () => {
    await service.listOperatorRecords({ tenantId: 't', limit: 5000 });
    expect((queryMock.mock.calls[0][1] as unknown[])[2]).toBe(200);

    queryMock.mockClear();
    await service.listOperatorRecords({ tenantId: 't', limit: 0 });
    expect((queryMock.mock.calls[0][1] as unknown[])[2]).toBe(1);

    queryMock.mockClear();
    await service.listOperatorRecords({ tenantId: 't' });
    expect((queryMock.mock.calls[0][1] as unknown[])[2]).toBe(50);
  });

  it('maps a row into the shape the dashboard reads', async () => {
    const created = new Date('2026-08-01T10:00:00Z');
    queryMock.mockResolvedValue({
      rows: [{
        id: 'esc-1',
        tenant_id: 't',
        agent_id: 'a',
        reason: 'connector unreachable',
        status: 'pending',
        created_at: created,
        resolved_at: null,
        occurrence_count: 4,
      }],
      rowCount: 1,
    });

    await expect(service.listOperatorRecords({ tenantId: 't' })).resolves.toEqual([{
      id: 'esc-1',
      tenantId: 't',
      agentId: 'a',
      reason: 'connector unreachable',
      status: 'pending',
      createdAt: created.toISOString(),
      resolvedAt: null,
      occurrenceCount: 4,
      context: null,
    }]);
  });

  it('defaults a missing occurrence count to one rather than undefined', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        id: 'esc-1', tenant_id: 't', agent_id: null, reason: 'x', status: 'resolved',
        created_at: new Date(), resolved_at: new Date(), occurrence_count: null,
      }],
      rowCount: 1,
    });

    const [record] = await service.listOperatorRecords({ tenantId: 't' });
    expect(record.occurrenceCount).toBe(1);
    expect(record.agentId).toBeNull();
  });
});
