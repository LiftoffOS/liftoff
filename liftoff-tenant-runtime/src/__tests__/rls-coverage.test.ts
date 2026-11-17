// The RLS ratchet for the tenant runtime.
//
// The control plane has enforced this for a long time: a generated table list, a
// lint rule that fails a raw pool query naming an RLS table, and a census test.
// This repo had nothing, because it was designed one tenant per database — and
// with one tenant per deployment, row isolation inside the database buys
// nothing, since the only rows present belong to that tenant.
//
// Production stopped matching that design. A single runtime now serves every
// tenant in its database, which turns "no policy on this table" from a
// no-op into the only thing standing between a query that forgot its
// `WHERE tenant_id` and another customer's rows.
//
// This does not pay the debt down; it stops it growing. A new tenant-scoped
// table must be classified when it is added, which for a new table is two
// ALTER statements and no backfill argument.

import { scanTenantTables } from './rls-coverage';
import { KNOWN_UNPROTECTED_TENANT_TABLES } from './known-unprotected-tenant-tables';

describe('tenant-scoped tables carry row-level protection', () => {
  const tables = scanTenantTables();

  it('finds the schema (guards against a scanner that silently matches nothing)', () => {
    // A parser that stops matching reports a clean tree, which is the one
    // failure mode a ratchet cannot survive: it would pass forever.
    expect(tables.length).toBeGreaterThan(80);
    expect(tables.filter((t) => t.protection === 'force').length).toBeGreaterThan(0);
    expect(tables.filter((t) => t.protection === 'rls').length).toBeGreaterThan(0);
  });

  it('adds no NEW unprotected tenant-scoped table', () => {
    const unprotected = tables
      .filter((t) => t.protection === 'none')
      .filter((t) => !KNOWN_UNPROTECTED_TENANT_TABLES.has(t.table));

    if (unprotected.length > 0) {
      const detail = unprotected
        .map((t) => `  ${t.table}  (added/last touched by ${t.lastTouchedBy})`)
        .join('\n');
      throw new Error(
        `${unprotected.length} tenant-scoped table(s) have no row-level protection:\n${detail}\n\n`
        + 'This runtime serves every tenant in its database, so a table with a tenant_id\n'
        + 'and no policy is one forgotten WHERE clause away from another customer\'s rows.\n\n'
        + 'Add to the migration that creates the table:\n'
        + '  ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;\n'
        + '  ALTER TABLE <t> FORCE ROW LEVEL SECURITY;\n'
        + '  CREATE POLICY <t>_tenant ON <t>\n'
        + "    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)\n"
        + "    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);\n\n"
        + 'FORCE matters: without it the table OWNER bypasses the policy, and the runtime\n'
        + 'connects as the owner of roughly half these tables.',
      );
    }
  });

  it('has no stale entry in the debt list', () => {
    // The ratchet only tightens. A table that gained protection but kept its
    // line here would let the next unprotected table with the same name slip
    // back in, and would misreport how much debt is left.
    const stillUnprotected = new Set(
      tables.filter((t) => t.protection === 'none').map((t) => t.table),
    );
    const stale = [...KNOWN_UNPROTECTED_TENANT_TABLES].filter((t) => !stillUnprotected.has(t));

    expect(stale).toEqual([]);
  });
});
