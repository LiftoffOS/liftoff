// The service opens its own withTenantScope transaction; mock it to invoke
// the callback synchronously with a stub client so the unit tests don't
// touch a real pool.
const fakeClient = {} as never;
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn((_tenantId: string, fn: (c: unknown) => unknown) => fn(fakeClient)),
}));

import { AuditLogService } from '../service';
import { RawRow } from '../types';
import { ValidationError } from '../../tenant-members/service';

describe('AuditLogService', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';

  function makeRow(overrides: Partial<RawRow> = {}): RawRow {
    return {
      source: 'audit_log',
      row_id: '11111111-1111-1111-1111-111111111111',
      occurred_at: new Date('2026-05-21T12:00:00.000Z'),
      tenant_id: tenantId,
      account_id: null,
      action: 'tenant.renamed',
      actor_id: '22222222-2222-2222-2222-222222222222',
      previous_state: { name: 'old' },
      new_state: { name: 'new' },
      ...overrides,
    };
  }

  function makeRepo(rows: RawRow[], rawCount?: number): {
    listUnifiedAuditEntries: jest.Mock;
  } {
    return {
      listUnifiedAuditEntries: jest.fn(async () => ({
        rows,
        rawCount: rawCount ?? rows.length,
      })),
    };
  }

  it('throws ValidationError when date range exceeds 90 days', async () => {
    const repo = makeRepo([]);
    const svc = new AuditLogService(repo as never);
    await expect(
      svc.list(
        tenantId,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-05-01T00:00:00.000Z'),
        {},
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when startDate is after endDate', async () => {
    const repo = makeRepo([]);
    const svc = new AuditLogService(repo as never);
    await expect(
      svc.list(
        tenantId,
        new Date('2026-05-21T12:00:00.000Z'),
        new Date('2026-05-20T12:00:00.000Z'),
        {},
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('clamps endDate to now (regression: legacy threw 400)', async () => {
    const repo = makeRepo([]);
    const svc = new AuditLogService(repo as never);
    const start = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await svc.list(tenantId, start, future, {});
    const argEnd = repo.listUnifiedAuditEntries.mock.calls[0][3] as Date;
    expect(argEnd.getTime()).toBeLessThanOrEqual(Date.now());
    expect(argEnd.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it('accepts a zero-day same-day range', async () => {
    const repo = makeRepo([]);
    const svc = new AuditLogService(repo as never);
    const t = new Date('2026-05-21T12:00:00.000Z');
    const result = await svc.list(tenantId, t, t, {});
    expect(result.entries).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('caps limit at 100 even when caller passes more', async () => {
    const repo = makeRepo([]);
    const svc = new AuditLogService(repo as never);
    const t = new Date('2026-05-21T12:00:00.000Z');
    await svc.list(tenantId, t, t, { limit: 500 });
    const argLimit = repo.listUnifiedAuditEntries.mock.calls[0][5] as number;
    expect(argLimit).toBe(100);
  });

  it('defaults limit to 50 when omitted', async () => {
    const repo = makeRepo([]);
    const svc = new AuditLogService(repo as never);
    const t = new Date('2026-05-21T12:00:00.000Z');
    await svc.list(tenantId, t, t, {});
    const argLimit = repo.listUnifiedAuditEntries.mock.calls[0][5] as number;
    expect(argLimit).toBe(50);
  });

  it('reports hasMore=true when the repo returns limit+1 rows', async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      makeRow({ row_id: `row-${i}` }),
    );
    const repo = makeRepo(rows, 3);
    const svc = new AuditLogService(repo as never);
    const t = new Date('2026-05-21T12:00:00.000Z');
    const result = await svc.list(tenantId, t, t, { limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it('reports hasMore=true even when dedup trimmed rows.length to <= limit', async () => {
    // Repo returned 3 raw rows (limit+1) but dedup collapsed one. Without
    // tracking rawCount the service would report hasMore=false and the UI
    // would silently stop paginating before reaching real subsequent rows.
    const rows = Array.from({ length: 2 }, (_, i) =>
      makeRow({ row_id: `row-${i}` }),
    );
    const repo = makeRepo(rows, 3); // dedup dropped 1
    const svc = new AuditLogService(repo as never);
    const t = new Date('2026-05-21T12:00:00.000Z');
    const result = await svc.list(tenantId, t, t, { limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it('emits null cursor when there is no next page', async () => {
    const repo = makeRepo([makeRow()]);
    const svc = new AuditLogService(repo as never);
    const t = new Date('2026-05-21T12:00:00.000Z');
    const result = await svc.list(tenantId, t, t, { limit: 50 });
    expect(result.entries).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('maps a raw row into the public AuditEntry shape', async () => {
    const repo = makeRepo([makeRow()]);
    const svc = new AuditLogService(repo as never);
    const t = new Date('2026-05-21T12:00:00.000Z');
    const result = await svc.list(tenantId, t, t, {});
    const entry = result.entries[0];
    expect(entry.id).toBe(
      'audit_log:11111111-1111-1111-1111-111111111111',
    );
    expect(entry.action).toBe('tenant.renamed');
    expect(entry.tenantId).toBe(tenantId);
    expect(entry.previousState).toEqual({ name: 'old' });
    expect(entry.newState).toEqual({ name: 'new' });
    expect(entry.createdAt).toBe('2026-05-21T12:00:00.000Z');
  });
});
