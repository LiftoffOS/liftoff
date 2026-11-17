#!/usr/bin/env node
/**
 * RLS posture ratchet — row security that is ENABLEd must not silently stay
 * unenforced, and the set of tables where it is unenforced must not grow.
 *
 * WHY THIS EXISTS
 *
 * `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` does not apply to the table's
 * OWNER. Only `FORCE ROW LEVEL SECURITY` does. In this estate the tables are
 * owned by `cloudsqlsuperuser` and the application role `tenant_app` is a
 * MEMBER of it, so Postgres treats the application as the owner and every
 * policy is inert for it. Check with:
 *
 *     SELECT pg_has_role('tenant_app','cloudsqlsuperuser','member');  -- t
 *
 * and a read of `connector_manifests` with `app.tenant_id` set to an all-zero
 * uuid returns rows. The policies are installed and correct; they filter
 * nothing. Migration 079's DO-block enables RLS over every table carrying a
 * `tenant_id`, which is why no text scan of the migrations can enumerate the
 * set — it has to be read from a database.
 *
 * WHY THIS DOES NOT JUST TURN FORCE ON
 *
 * Because that would take the runtime down. `withTenantScope` is used at 35
 * call sites against 158 raw `getPoolForService` sites, so the great majority
 * of queries run with no `app.tenant_id` set and only work today BECAUSE the
 * policies are inert. Forcing them would fail those reads, not fix them.
 * Closing this properly is the same programme platform-backend ran: scope the
 * callers, give the legitimate cross-tenant sweepers an explicit admin path,
 * then force. That is a project, not a migration.
 *
 * WHAT THIS DOES INSTEAD
 *
 * Freezes the debt. A table already in the baseline is tolerated. A NEW table
 * that lands with RLS enabled and unforced fails the check, so the next
 * tenant-scoped table has to be scoped properly or exempted deliberately. A
 * table that GAINS force must be removed from the baseline, so the list can
 * only shrink.
 *
 * EXIT CODES — the convention verify-migrations established.
 *   0  posture unchanged or improved
 *   1  a new table joined the debt, or the baseline is stale
 *   2  INCONCLUSIVE: no database. Does NOT block — a check that could not run
 *      knows nothing, and a gate that fails the build over its own plumbing
 *      gets deleted rather than fixed.
 */
const { readFileSync } = require('fs');
const { join } = require('path');

const BASELINE_PATH = join(__dirname, 'rls-not-forced-baseline.json');

/** The whole decision, separated from the database and the process so it can be
 *  tested without either.
 *
 *  `rows` is [{ table_name, forced }] for every table with row security on.
 *  A baseline entry matching NEITHER set is a table this database does not
 *  have — a rename, a drop, or an entry carried from another environment — and
 *  is deliberately not a failure. */
function classifyPosture(rows, baselineTables) {
  const baseline = new Set(baselineTables);
  const notForced = rows.filter((r) => !r.forced).map((r) => r.table_name).sort();
  const forced = new Set(rows.filter((r) => r.forced).map((r) => r.table_name));
  return {
    notForced,
    added: notForced.filter((t) => !baseline.has(t)),
    fixed: [...baseline].filter((t) => forced.has(t)).sort(),
  };
}
const QUERY = `
  SELECT relname AS table_name, relforcerowsecurity AS forced
    FROM pg_class
   WHERE relkind IN ('r','p')
     AND relnamespace = 'public'::regnamespace
     AND relrowsecurity
   ORDER BY relname`;

async function main() {
  const printOnly = process.argv.includes('--print');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('check-rls-posture: INCONCLUSIVE — DATABASE_URL is required (a migrated database).');
    process.exit(2);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch {
    console.error('check-rls-posture: INCONCLUSIVE — the pg client is not installed.');
    process.exit(2);
  }

  const client = new Client({ connectionString: url });
  let rows;
  try {
    await client.connect();
    ({ rows } = await client.query(QUERY));
  } catch (err) {
    console.error(`check-rls-posture: INCONCLUSIVE — ${err.message}`);
    process.exit(2);
  } finally {
    await client.end().catch(() => undefined);
  }

  const baselineTables = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).tables;
  const { notForced, added, fixed } = classifyPosture(rows, baselineTables);

  if (printOnly) {
    process.stdout.write(JSON.stringify({ tables: notForced }, null, 2) + '\n');
    process.exit(0);
  }

  if (added.length === 0 && fixed.length === 0) {
    console.log(`check-rls-posture: OK — ${notForced.length} tables ENABLEd without FORCE, all known.`);
    process.exit(0);
  }

  if (added.length > 0) {
    console.error('');
    console.error('check-rls-posture: FAIL — row security is enabled but NOT FORCED on new table(s):');
    for (const t of added) console.error(`  - ${t}`);
    console.error('');
    console.error('  ENABLE alone exempts the table owner, and the application role is a member');
    console.error('  of the owning role, so the policy on these tables will filter nothing.');
    console.error('');
    console.error('  Either add `ALTER TABLE <t> FORCE ROW LEVEL SECURITY` in the migration and');
    console.error('  make sure every reader goes through withTenantScope, or add the table to');
    console.error(`  ${BASELINE_PATH} with a reason if it genuinely cannot be scoped yet.`);
  }

  if (fixed.length > 0) {
    console.error('');
    console.error('check-rls-posture: FAIL — these are FORCED now and still listed as debt:');
    for (const t of fixed) console.error(`  - ${t}`);
    console.error('');
    console.error('  Remove them from the baseline. The list only shrinks.');
  }
  console.error('');
  process.exit(1);
}

module.exports = { classifyPosture, BASELINE_PATH };

if (require.main === module) {
  main().catch((err) => {
    console.error(`check-rls-posture: INCONCLUSIVE — ${err.message}`);
    process.exit(2);
  });
}
