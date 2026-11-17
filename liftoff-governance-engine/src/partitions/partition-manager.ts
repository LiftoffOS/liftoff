// Partition management helpers for governance-pg.
//
// Migration 001 pre-creates 18 monthly partitions for `actions` and
// `usage_events` (2026-04 through 2027-09). Without automation we start
// returning write errors in 2027-10. This module provides pure helpers
// that:
//   1. Enumerate the partitions we want to exist (current → +future_months)
//   2. Enumerate the partitions we want to drop (older than retain_months)
//   3. Generate the DDL for CREATE / DETACH / DROP statements
//
// Keeping the logic pure means we can unit-test without a live Postgres.
// The top-level script (scripts/partitions/manage-partitions.ts) wires
// these helpers to a `pg` Pool and a CLI parser.
//
// Native Postgres partition DDL is used — no pg_partman dep. Partition
// volumes are predictable (2 tables * 1 per month ≈ 48 / year) so the
// extension's extra operational surface isn't worth the trade-off here.

// Tables we manage. Both are monthly range-partitioned on created_at per
// migration 001. If a future migration adds another partitioned table,
// extend this list and run `npm run partitions` to provision it.
export const PARTITIONED_TABLES = ['actions', 'usage_events'] as const;
export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

export interface MonthKey {
  // 4-digit year
  year: number;
  // 1..12
  month: number;
}

// Format a MonthKey as YYYY-MM-01 (first of month, UTC).
export function monthStart(m: MonthKey): string {
  const yy = String(m.year).padStart(4, '0');
  const mm = String(m.month).padStart(2, '0');
  return `${yy}-${mm}-01`;
}

// Format a MonthKey as YYYY_MM — used as the partition table name suffix,
// matching migration 001 (actions_2026_04 / usage_events_2026_04).
export function monthSuffix(m: MonthKey): string {
  const yy = String(m.year).padStart(4, '0');
  const mm = String(m.month).padStart(2, '0');
  return `${yy}_${mm}`;
}

// Return the MonthKey of the calendar month containing `d` (UTC).
export function monthKeyForDate(d: Date): MonthKey {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

// Add `delta` months (can be negative) to a MonthKey. Normalises across
// year boundaries.
export function addMonths(m: MonthKey, delta: number): MonthKey {
  const total = m.year * 12 + (m.month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

// Return [a, b) — months at or after `from` and strictly before `to`.
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const out: MonthKey[] = [];
  let cur = from;
  while (cur.year * 12 + cur.month < to.year * 12 + to.month) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

// Compare m < b.
export function monthLt(a: MonthKey, b: MonthKey): boolean {
  return a.year * 12 + a.month < b.year * 12 + b.month;
}

export function partitionName(table: PartitionedTable, m: MonthKey): string {
  return `${table}_${monthSuffix(m)}`;
}

// CREATE TABLE <table>_YYYY_MM PARTITION OF <table>
//   FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM-01');
export function createPartitionDDL(table: PartitionedTable, m: MonthKey): string {
  const name = partitionName(table, m);
  const from = monthStart(m);
  const to = monthStart(addMonths(m, 1));
  return `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${table} FOR VALUES FROM ('${from}') TO ('${to}');`;
}

// Detach before drop so in-flight selects don't race a dropped partition.
// In Postgres 14+ we'd use DETACH PARTITION CONCURRENTLY, but that can't
// run inside a transaction. Keeping the simpler non-concurrent path —
// partition management runs on a cron in the dead of night and the window
// between DETACH and DROP is sub-second.
export function detachPartitionDDL(table: PartitionedTable, m: MonthKey): string {
  return `ALTER TABLE ${table} DETACH PARTITION ${partitionName(table, m)};`;
}

export function dropPartitionDDL(table: PartitionedTable, m: MonthKey): string {
  return `DROP TABLE IF EXISTS ${partitionName(table, m)};`;
}

export interface PartitionPlan {
  toCreate: Array<{ table: PartitionedTable; month: MonthKey; ddl: string }>;
  toDrop: Array<{ table: PartitionedTable; month: MonthKey; detachDDL: string; dropDDL: string }>;
  skippedExisting: Array<{ table: PartitionedTable; month: MonthKey }>;
}

export interface BuildPlanInput {
  // The current timestamp — captured once at the top of the run so month
  // arithmetic is deterministic.
  now: Date;
  // Months of forward coverage. We ensure the current month and
  // futureMonths additional months exist. Default 3.
  futureMonths: number;
  // Partitions older than `now - retainMonths` are candidates for drop.
  // Default 18.
  retainMonths: number;
  // Month-resolution inventory of partitions that actually exist in the
  // database, per table. Populated by the script via pg_inherits.
  existing: Record<PartitionedTable, Set<string>>;
}

// Build the create/drop plan for all managed tables. Pure — no IO.
export function buildPartitionPlan(input: BuildPlanInput): PartitionPlan {
  const currentMonth = monthKeyForDate(input.now);
  const forwardEnd = addMonths(currentMonth, input.futureMonths + 1); // exclusive
  const retentionCutoff = addMonths(currentMonth, -input.retainMonths); // strictly-older threshold

  const plan: PartitionPlan = { toCreate: [], toDrop: [], skippedExisting: [] };

  for (const table of PARTITIONED_TABLES) {
    const existing = input.existing[table] ?? new Set<string>();

    // ─── Create: current month through current + futureMonths ──────────────
    const targetCreate = monthRange(currentMonth, forwardEnd);
    for (const m of targetCreate) {
      if (existing.has(partitionName(table, m))) {
        plan.skippedExisting.push({ table, month: m });
      } else {
        plan.toCreate.push({
          table,
          month: m,
          ddl: createPartitionDDL(table, m),
        });
      }
    }

    // ─── Drop: any existing partition with month < retentionCutoff ────────
    for (const name of existing) {
      const parsed = parsePartitionName(table, name);
      if (!parsed) continue; // un-managed partition — leave alone
      if (monthLt(parsed, retentionCutoff)) {
        plan.toDrop.push({
          table,
          month: parsed,
          detachDDL: detachPartitionDDL(table, parsed),
          dropDDL: dropPartitionDDL(table, parsed),
        });
      }
    }
  }

  return plan;
}

// Parse `actions_2026_04` → { year: 2026, month: 4 }. Returns null for
// anything that doesn't match <table>_YYYY_MM exactly.
export function parsePartitionName(
  table: PartitionedTable,
  name: string,
): MonthKey | null {
  const prefix = `${table}_`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const match = /^(\d{4})_(\d{2})$/.exec(rest);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return null;
  return { year, month };
}
