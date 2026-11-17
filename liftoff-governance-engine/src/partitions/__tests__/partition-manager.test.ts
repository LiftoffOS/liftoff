// Unit tests for the pure partition planning logic.
//
// The DB-facing code in scripts/partitions/manage-partitions.ts only does
// IO + CLI parsing. All the correctness work — which months to create,
// which to drop, what DDL to emit — is under test here.

import {
  PARTITIONED_TABLES,
  addMonths,
  buildPartitionPlan,
  createPartitionDDL,
  detachPartitionDDL,
  dropPartitionDDL,
  monthKeyForDate,
  monthRange,
  monthStart,
  monthSuffix,
  parsePartitionName,
  partitionName,
} from '../partition-manager';

describe('month helpers', () => {
  it('monthStart formats as YYYY-MM-01', () => {
    expect(monthStart({ year: 2026, month: 4 })).toBe('2026-04-01');
    expect(monthStart({ year: 2027, month: 12 })).toBe('2027-12-01');
  });

  it('monthSuffix formats as YYYY_MM', () => {
    expect(monthSuffix({ year: 2026, month: 4 })).toBe('2026_04');
    expect(monthSuffix({ year: 2027, month: 12 })).toBe('2027_12');
  });

  it('addMonths crosses year boundaries', () => {
    expect(addMonths({ year: 2026, month: 11 }, 3)).toEqual({ year: 2027, month: 2 });
    expect(addMonths({ year: 2026, month: 2 }, -3)).toEqual({ year: 2025, month: 11 });
  });

  it('monthKeyForDate uses UTC', () => {
    // 2026-04-19 UTC
    expect(monthKeyForDate(new Date('2026-04-19T00:00:00Z'))).toEqual({
      year: 2026,
      month: 4,
    });
  });

  it('monthRange is half-open [from, to)', () => {
    const range = monthRange({ year: 2026, month: 4 }, { year: 2026, month: 7 });
    expect(range).toEqual([
      { year: 2026, month: 4 },
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
    ]);
  });
});

describe('DDL generation', () => {
  it('createPartitionDDL uses correct FROM / TO bounds', () => {
    const ddl = createPartitionDDL('actions', { year: 2027, month: 10 });
    expect(ddl).toBe(
      "CREATE TABLE IF NOT EXISTS actions_2027_10 PARTITION OF actions FOR VALUES FROM ('2027-10-01') TO ('2027-11-01');",
    );
  });

  it('createPartitionDDL handles year rollover', () => {
    const ddl = createPartitionDDL('usage_events', { year: 2027, month: 12 });
    expect(ddl).toBe(
      "CREATE TABLE IF NOT EXISTS usage_events_2027_12 PARTITION OF usage_events FOR VALUES FROM ('2027-12-01') TO ('2028-01-01');",
    );
  });

  it('detach + drop DDL reference the child partition name', () => {
    expect(detachPartitionDDL('actions', { year: 2025, month: 1 })).toBe(
      'ALTER TABLE actions DETACH PARTITION actions_2025_01;',
    );
    expect(dropPartitionDDL('actions', { year: 2025, month: 1 })).toBe(
      'DROP TABLE IF EXISTS actions_2025_01;',
    );
  });
});

describe('parsePartitionName', () => {
  it('parses valid names', () => {
    expect(parsePartitionName('actions', 'actions_2026_04')).toEqual({
      year: 2026,
      month: 4,
    });
    expect(parsePartitionName('usage_events', 'usage_events_2027_12')).toEqual({
      year: 2027,
      month: 12,
    });
  });

  it('rejects wrong parent', () => {
    expect(parsePartitionName('actions', 'usage_events_2026_04')).toBeNull();
  });

  it('rejects malformed suffix', () => {
    expect(parsePartitionName('actions', 'actions_2026')).toBeNull();
    expect(parsePartitionName('actions', 'actions_20260')).toBeNull();
    expect(parsePartitionName('actions', 'actions_2026_13')).toBeNull();
    expect(parsePartitionName('actions', 'actions_2026_00')).toBeNull();
  });

  it('rejects adjacent ad-hoc tables', () => {
    // e.g. a manually-created detached archive table we should leave alone.
    expect(parsePartitionName('actions', 'actions_archive')).toBeNull();
  });
});

describe('buildPartitionPlan', () => {
  const now = new Date('2026-04-19T12:00:00Z'); // month = 2026-04

  it('creates current month + futureMonths when nothing exists', () => {
    const plan = buildPartitionPlan({
      now,
      futureMonths: 3,
      retainMonths: 18,
      existing: { actions: new Set(), usage_events: new Set() },
    });

    // 4 months (current + 3) * 2 tables = 8 creates
    expect(plan.toCreate).toHaveLength(8);
    expect(plan.toDrop).toHaveLength(0);
    expect(plan.skippedExisting).toHaveLength(0);

    const names = plan.toCreate.map(c => partitionName(c.table, c.month)).sort();
    expect(names).toEqual([
      'actions_2026_04',
      'actions_2026_05',
      'actions_2026_06',
      'actions_2026_07',
      'usage_events_2026_04',
      'usage_events_2026_05',
      'usage_events_2026_06',
      'usage_events_2026_07',
    ]);
  });

  it('skips months that already exist', () => {
    const plan = buildPartitionPlan({
      now,
      futureMonths: 3,
      retainMonths: 18,
      existing: {
        actions: new Set(['actions_2026_04', 'actions_2026_05']),
        usage_events: new Set(['usage_events_2026_04']),
      },
    });

    // 8 targets total, 3 already exist → 5 creates.
    expect(plan.toCreate).toHaveLength(5);
    expect(plan.skippedExisting).toHaveLength(3);

    const created = plan.toCreate.map(c => partitionName(c.table, c.month)).sort();
    expect(created).toEqual([
      'actions_2026_06',
      'actions_2026_07',
      'usage_events_2026_05',
      'usage_events_2026_06',
      'usage_events_2026_07',
    ]);
  });

  it('drops partitions older than retainMonths', () => {
    // now = 2026-04, retainMonths = 18 → cutoff = 2024-10 (strictly older)
    // existing partitions including some old ones (2024-09, 2024-08) and
    // some that should be retained (2024-10, 2024-11, 2026-04).
    const plan = buildPartitionPlan({
      now,
      futureMonths: 3,
      retainMonths: 18,
      existing: {
        actions: new Set([
          'actions_2024_08',
          'actions_2024_09',
          'actions_2024_10',
          'actions_2024_11',
          'actions_2026_04',
        ]),
        usage_events: new Set(['usage_events_2024_09', 'usage_events_2026_04']),
      },
    });

    const dropped = plan.toDrop.map(d => partitionName(d.table, d.month)).sort();
    expect(dropped).toEqual([
      'actions_2024_08',
      'actions_2024_09',
      'usage_events_2024_09',
    ]);

    // Each drop has both DETACH and DROP DDL, in that order.
    for (const step of plan.toDrop) {
      expect(step.detachDDL).toContain('DETACH PARTITION');
      expect(step.dropDDL).toContain('DROP TABLE IF EXISTS');
    }
  });

  it('leaves unmanaged child names alone', () => {
    const plan = buildPartitionPlan({
      now,
      futureMonths: 1,
      retainMonths: 6,
      existing: {
        actions: new Set(['actions_archive', 'actions_legacy_q1', 'actions_2025_08']),
        usage_events: new Set(),
      },
    });

    // actions_archive + actions_legacy_q1 don't match — no drop proposals.
    // actions_2025_08 IS parsed and IS older than the 6-month cutoff (2025-10).
    const dropped = plan.toDrop.map(d => partitionName(d.table, d.month));
    expect(dropped).toEqual(['actions_2025_08']);
  });

  it('is consistent across both managed tables', () => {
    const plan = buildPartitionPlan({
      now,
      futureMonths: 2,
      retainMonths: 18,
      existing: { actions: new Set(), usage_events: new Set() },
    });

    // 3 months * 2 tables = 6 creates
    expect(plan.toCreate).toHaveLength(6);
    const tables = new Set(plan.toCreate.map(c => c.table));
    expect(tables).toEqual(new Set(PARTITIONED_TABLES));
  });

  it('futureMonths = 0 still creates the current month', () => {
    const plan = buildPartitionPlan({
      now,
      futureMonths: 0,
      retainMonths: 18,
      existing: { actions: new Set(), usage_events: new Set() },
    });
    const names = plan.toCreate.map(c => partitionName(c.table, c.month)).sort();
    expect(names).toEqual(['actions_2026_04', 'usage_events_2026_04']);
  });
});
