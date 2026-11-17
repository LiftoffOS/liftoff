// Rule tests for r5/no-unguarded-pool-construction.
//
// pg-pool removes its own `error` listener the moment a client is checked out, so
// a borrowed client that errors is an unhandled 'error' event and the container
// exits. `installBorrowedClientGuard` closes that window, and it is installed at
// pool CONSTRUCTION — so a pool built anywhere else has no guard, and nothing
// about a missing guard is visible until the day a socket drops.
//
// The exemptions are the whole subtlety, and each is a deliberate decision rather
// than a convenience: a one-shot script or a test owns its own connection and
// taking it down takes nothing else with it. Getting those wrong in either
// direction is how this rule would end up either switched off or useless.

import { RuleTester } from 'eslint';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../eslint-rules/no-unguarded-pool-construction.js');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const POOL = `
  const p = new Pool({ host: '/cloudsql/x', max: 5 });
`;

ruleTester.run('r5/no-unguarded-pool-construction', rule, {
  valid: [
    {
      name: 'the sanctioned constructor file, which installs the guard on each pool',
      filename: 'src/infrastructure/database.ts',
      code: POOL,
    },
    {
      name: 'a one-shot operational script owns its own connection',
      filename: 'src/scripts/backfill-tenant-subscriptions.ts',
      code: POOL,
    },
    {
      name: 'a test file',
      filename: 'src/oauth/__tests__/lock-order.integration.test.ts',
      code: POOL,
    },
    {
      name: 'a test file outside a __tests__ directory',
      filename: 'src/llm/usage-tracker.integration.test.ts',
      code: POOL,
    },
    {
      name: 'the test-utils harness',
      filename: 'src/test-utils/integration-helpers.ts',
      code: POOL,
    },
    {
      name: 'a production file that does not build a pool',
      filename: 'src/billing/spend-subscriber.ts',
      code: `
        const client = await pool.connect();
        try { await client.query('SELECT 1'); } finally { client.release(); }
      `,
    },
    {
      name: 'constructing something else entirely',
      filename: 'src/billing/spend-subscriber.ts',
      code: `
        const s = new Set();
        const m = new Map();
        const c = new PoolClient();
      `,
    },
  ],

  invalid: [
    {
      name: 'a request-path module building its own pool',
      filename: 'src/insights/report-service.ts',
      code: POOL,
      errors: [{ messageId: 'unguarded' }],
    },
    {
      name: 'a background worker building its own pool',
      filename: 'src/jobs/sync-dropbox-folders.ts',
      code: `
        const workerPool = new Pool({ connectionString: process.env.DATABASE_URL });
      `,
      errors: [{ messageId: 'unguarded' }],
    },
    {
      name: 'the namespaced spelling',
      filename: 'src/insights/report-service.ts',
      code: `
        import * as pg from 'pg';
        const p = new pg.Pool({ max: 2 });
      `,
      errors: [{ messageId: 'unguarded' }],
    },
    {
      name: 'a second pool in the same file is a second report',
      filename: 'src/insights/report-service.ts',
      code: `
        const a = new Pool({ max: 1 });
        const b = new Pool({ max: 2 });
      `,
      errors: [{ messageId: 'unguarded' }, { messageId: 'unguarded' }],
    },
    {
      name: 'a file whose NAME contains "test" but is production code',
      // `src/test-utils/` and `*.test.ts` are exempt; a module that merely has
      // "test" in its name is not, or the exemption would be a way around the
      // rule rather than a carve-out for code that owns its own connection.
      filename: 'src/scripts-testing/harness.ts',
      code: POOL,
      errors: [{ messageId: 'unguarded' }],
    },
  ],
});
