// The RLS posture ratchet's decision, tested without a database.
//
// `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` exempts the table OWNER; only
// FORCE does not. Here the tables are owned by `cloudsqlsuperuser` and the
// application role is a MEMBER of it, so Postgres treats the application as the
// owner and every policy is inert for it on any unforced table.
//
// Forcing them is not a migration: `withTenantScope` covers 35 call sites
// against 158 raw pool sites, so most queries only work BECAUSE the policies do
// nothing. Until the callers are scoped, the honest move is to freeze the debt
// so it cannot quietly grow — which is what this check does, and what these
// tests pin.

import { classifyPosture, BASELINE_PATH } from '../ci/check-rls-posture.cjs';
import { readFileSync } from 'fs';

type Row = { table_name: string; forced: boolean };

const BASELINE: string[] = ['agents', 'audit_logs', 'connector_manifests'];

describe('classifyPosture', () => {
  it('passes when the unforced set is exactly the frozen debt', () => {
    const rows: Row[] = [
      { table_name: 'agents', forced: false },
      { table_name: 'audit_logs', forced: false },
      { table_name: 'connector_manifests', forced: false },
    ];
    const { added, fixed } = classifyPosture(rows, BASELINE);
    expect(added).toEqual([]);
    expect(fixed).toEqual([]);
  });

  it('fails a NEW table that lands enabled but unforced', () => {
    // The failure the check exists for: the next tenant-scoped table joining
    // the debt without anyone deciding to.
    const rows: Row[] = [
      { table_name: 'agents', forced: false },
      { table_name: 'brand_new_table', forced: false },
    ];
    expect(classifyPosture(rows, BASELINE).added).toEqual(['brand_new_table']);
  });

  it('fails a table that gained FORCE and was left in the baseline', () => {
    // The ratchet only tightens. A baseline that overstates the problem stops
    // being a description of it.
    const rows: Row[] = [
      { table_name: 'agents', forced: true },
      { table_name: 'audit_logs', forced: false },
    ];
    const { added, fixed } = classifyPosture(rows, BASELINE);
    expect(fixed).toEqual(['agents']);
    expect(added).toEqual([]);
  });

  it('ignores a baseline entry this database does not have', () => {
    // Renamed, dropped, or carried from another environment. Not a failure:
    // the ratchet is about tables that exist here.
    const rows: Row[] = [{ table_name: 'agents', forced: false }];
    const { added, fixed } = classifyPosture(rows, BASELINE);
    expect(added).toEqual([]);
    expect(fixed).toEqual([]);
  });

  it('says nothing about tables without row security at all', () => {
    // The query only returns relrowsecurity tables, so a table with no RLS
    // never reaches this function. Pinned because widening that query later
    // would turn every unprotected table into a false failure.
    const rows: Row[] = [];
    expect(classifyPosture(rows, BASELINE).notForced).toEqual([]);
  });
});

describe('the checked-in baseline', () => {
  it('is the measured debt, not an empty list', () => {
    // An empty baseline would make the ratchet vacuous in the safe direction:
    // everything would read as new debt and the check would be disabled.
    const tables: string[] = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).tables;
    expect(tables.length).toBeGreaterThan(50);
    expect(tables).toContain('connector_manifests');
    expect([...tables].sort()).toEqual(tables);
  });
});
