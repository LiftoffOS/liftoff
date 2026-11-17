// Rule tests for r5/no-raw-pool-on-rls-table (INV-PB-001).
//
// The anchor case is a real shape: a tenant_members read on a raw pool, which
// 500s on every call. A rule that does not fail on that exact snippet is not
// doing its job, so it is pinned here verbatim.

import { RuleTester } from 'eslint';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../eslint-rules/no-raw-pool-on-rls-table.js');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

// Not a *.test.ts path — the rule exempts test files, so these must look like
// production sources or every case would trivially pass.
const FILENAME = 'src/accounts/repository.ts';

// RuleTester emits its own describe/it blocks, so it runs at the top level.
ruleTester.run('r5/no-raw-pool-on-rls-table', rule, {
  valid: [
    {
      // The fix for the raw-pool read.
      name: 'tenant-scoped client is the correct shape',
      filename: FILENAME,
      code: `
        const result = await withTenantScope(tenantId, (client) => client.query(
          \`SELECT a.id FROM accounts a JOIN tenant_members tm ON tm.account_id = a.id\`,
          [ids],
        ));
      `,
    },
    {
      name: 'withAdminScope client is also scoped',
      filename: FILENAME,
      code: `
        const rows = await withAdminScope({ caller: 'x', reason: 'y' }, (db) => db.query(
          \`SELECT * FROM entitlements WHERE tenant_id = $1\`, [t],
        ));
      `,
    },
    {
      name: 'raw pool against platform-global tables is allowed (INV-PB-005)',
      filename: FILENAME,
      code: `
        const r = await getPool().query(\`SELECT id FROM accounts WHERE id = $1\`, [id]);
        const s = await pool.query(\`SELECT id FROM tenants WHERE account_id = $1\`, [id]);
        const t = await pool.query(\`SELECT key FROM addon_catalog WHERE active = TRUE\`);
      `,
    },
    {
      name: 'the escape hatch suppresses the report',
      filename: FILENAME,
      code: `
        // RLS_RAW_POOL_OK: standalone script on a BYPASSRLS role
        const r = await pool.query(\`SELECT * FROM billing_spend_events\`);
      `,
    },
    {
      name: 'test files are exempt',
      filename: 'src/accounts/__tests__/repository.test.ts',
      code: `const r = await pool.query(\`SELECT * FROM tenant_members\`);`,
    },
  ],

  invalid: [
    {
      // The raw-pool read, verbatim.
      name: 'tenant_members joined on a raw pool',
      filename: FILENAME,
      code: `
        const pool = getPool();
        const result = await pool.query(
          \`SELECT a.id, a.first_name, a.last_name, a.email, a.avatar_url
           FROM accounts a
           JOIN tenant_members tm ON tm.account_id = a.id
           WHERE a.id = ANY($1::uuid[])
             AND tm.tenant_id = $2
             AND a.deleted_at IS NULL\`,
          [accountIds, tenantId],
        );
      `,
      errors: [{ messageId: 'unscoped' }],
    },
    {
      name: 'getPool().query inline',
      filename: FILENAME,
      code: `const r = await getPool().query(\`SELECT * FROM internal_agents WHERE id = $1\`, [id]);`,
      errors: [{ messageId: 'unscoped' }],
    },
    {
      name: 'this.pool on a repository class',
      filename: FILENAME,
      code: `const r = await this.pool.query(\`UPDATE agent_audit_logs SET outcome = $1\`, [o]);`,
      errors: [{ messageId: 'unscoped' }],
    },
    {
      name: 'INSERT INTO is caught too, not just reads',
      filename: FILENAME,
      code: `await pool.query(\`INSERT INTO entitlements (tenant_id) VALUES ($1)\`, [t]);`,
      errors: [{ messageId: 'unscoped' }],
    },
    {
      // Partitioned parents (pg_class.relkind='p') were missing from the first
      // version of rls-tables.json, because the generator filtered to relkind='r'
      // and that silently drops them. They are the names code actually writes --
      // nothing queries a partition child directly -- so the gap covered every
      // cost and metering query in the repo. Postgres applies the child's policy
      // to a read of the parent: an unscoped count against
      // cost_attribution_events raises 42704.
      //
      // This used to assert on tenant_resource_usage as well. Migration 340
      // dropped that table, but rls-tables.json was not regenerated at the time,
      // so the stale entry kept this case passing on a name that no longer
      // exists anywhere. cost_attribution_events is the surviving parent and is
      // the one that carries the guarantee.
      name: 'partitioned parents are covered, not just plain tables',
      filename: FILENAME,
      code: `
        const a = await pool.query(\`SELECT count(*) FROM cost_attribution_events WHERE tenant_id = $1\`, [t]);
      `,
      errors: [{ messageId: 'unscoped' }],
    },
    {
      name: 'an unrelated comment does not count as the escape hatch',
      filename: FILENAME,
      code: `
        // this is fine, honest
        const r = await pool.query(\`SELECT * FROM tenant_members\`);
      `,
      errors: [{ messageId: 'unscoped' }],
    },
  ],
});
