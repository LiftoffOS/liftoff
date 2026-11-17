// Rule tests for r5/no-turn-locks-outside-registry (INV-PB-018).
//
// The anchor cases are the real ones: the four hand-written copies of "is a turn
// running on this thread" that existed before the registry, each asking the lease
// and none asking whether anything was serving the thread, two of them directly
// under a comment asserting the opposite. They are pinned here verbatim — a rule that
// does not fail on them is not doing its job, and the whole point of the rule is
// that a comment could not hold the line.
//
// The invalid cases matter more than usual here. This rule's job is to be silent
// forever and then fail once, years later, when somebody adds a fifth reader. A
// rule that cannot fail is a rule nobody knows is broken.

import { RuleTester } from 'eslint';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../eslint-rules/no-turn-locks-outside-registry.js');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

// Production paths: the rule exempts tests and the registry itself, so a case
// filed under either would pass trivially and prove nothing.
const LIFTOFF = 'src/liftoff/turn-control.ts';
const INSIGHTS = 'src/insights/turn-control.ts';
const PRESENCE = 'src/common/chat-presence-repository.ts';

ruleTester.run('r5/no-turn-locks-outside-registry', rule, {
  valid: [
    {
      name: 'the registry itself owns the tables',
      filename: 'src/common/turn-registry.ts',
      code: `
        const r = await c.query(\`SELECT turn_id FROM liftoff_turn_locks WHERE tenant_id = $1\`, [t]);
        await c.query(\`DELETE FROM insights_turn_locks WHERE tenant_id = $1\`, [t]);
      `,
    },
    {
      name: 'a caller that goes through the registry names no table',
      filename: LIFTOFF,
      code: `
        const turnId = await registryFindActiveTurnId(SURFACE, tenantId, threadId);
        const rowCount = await heartbeatLock(SURFACE, tenantId, threadId, turnId);
      `,
    },
    {
      name: 'the degrade-open log message names the table as PROSE, and must stay allowed',
      filename: LIFTOFF,
      // Both surfaces say this when their migration has not landed yet. It is
      // what an operator reads, and a rule that forced it to be reworded would
      // cost real diagnosability to enforce nothing.
      code: `
        log.warn({ tenantId }, 'liftoff_turn_locks missing: running the turn without mid-run control');
      `,
    },
    {
      name: 'a comment naming the table is not a query',
      filename: PRESENCE,
      code: `
        // The lock tables used to be here too, which is how this file came to
        // hold a fourth copy of "is a turn running": insights_turn_locks and
        // liftoff_turn_locks are the registry's now.
        const live = await registryLiveTurnId(surface, tenantId, threadId, client);
      `,
    },
    {
      name: 'the SIGNAL tables are not lock tables and carry no liveness question',
      filename: LIFTOFF,
      code: `
        await client.query(\`INSERT INTO liftoff_turn_signals (turn_id, signal_kind) VALUES ($1, $2)\`, [t, k]);
        await client.query(\`UPDATE insights_turn_signals SET consumed_at = NOW() WHERE id = $1\`, [i]);
      `,
    },
    {
      name: 'a KNOWN BLIND SPOT, stated rather than hidden: an interpolated table name',
      filename: PRESENCE,
      // This is the shape the fourth copy actually had, and the rule cannot see
      // it — the table name is not in the source text, it is in a map. Matching
      // `FROM ${...}` would flag every dynamic-table query in the repo, so the
      // rule does not try.
      //
      // What closes it is structural rather than lexical: the only map that ever
      // held these names was `SURFACE_TABLES` in this file, and this change
      // removed its `locks` key, so there is nothing left to interpolate FROM.
      // A future reader would have to write the name as a literal, which is
      // caught, or assemble it from fragments, which nothing here does.
      code: `
        const live = await client.query(
          \`SELECT MAX(created_at) FROM \${tables.messages} WHERE thread_id = $1\`,
          [threadId],
        );
      `,
    },
    {
      name: 'a test may assert on the SQL the registry emits',
      filename: 'src/liftoff/__tests__/turn-control.test.ts',
      code: `
        expect(calls[0].sql).toContain('DELETE FROM liftoff_turn_locks');
      `,
    },
  ],

  invalid: [
    {
      // THE ORIGINAL SHAPE, copied out of src/liftoff/turn-control.ts as it stood.
      name: "liftoff's own findActiveTurnId, which asked the lease",
      filename: LIFTOFF,
      code: `
        const result = await client.query(
          \`SELECT turn_id FROM liftoff_turn_locks
           WHERE tenant_id = $1 AND thread_id = $2 AND expires_at > NOW()\`,
          [tenantId, threadId],
        );
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: "insights' copy of the same query",
      filename: INSIGHTS,
      code: `
        const result = await client.query(
          \`SELECT turn_id FROM insights_turn_locks
           WHERE tenant_id = $1 AND thread_id = $2 AND expires_at > NOW()\`,
          [tenantId, threadId],
        );
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: 'the acquire path reclaiming only expired rows',
      filename: LIFTOFF,
      code: `
        await client.query(
          \`DELETE FROM liftoff_turn_locks
           WHERE tenant_id = $1 AND thread_id = $2 AND expires_at <= NOW()\`,
          [tenantId, threadId],
        );
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: 'a write, wherever it is written',
      filename: 'src/liftoff/some-new-module.ts',
      code: `
        const SQL = \`UPDATE liftoff_turn_locks SET expires_at = NOW() + INTERVAL '20 minutes'\`;
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: 'an INSERT, and a plain single-quoted string counts too',
      filename: 'src/liftoff/some-new-module.ts',
      code: `
        const sql = 'INSERT INTO insights_turn_locks (tenant_id, thread_id) VALUES ($1, $2)';
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: 'a JOIN onto a lock table from a reporting query',
      filename: 'src/insights/report-service.ts',
      code: `
        const r = await client.query(
          \`SELECT t.id FROM threads t JOIN insights_turn_locks l ON l.thread_id = t.id\`,
        );
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: 'both tables in one statement is still one report per literal',
      filename: 'src/scripts/some-sweep.ts',
      code: `
        const sql = \`
          DELETE FROM liftoff_turn_locks WHERE expires_at < NOW();
          DELETE FROM insights_turn_locks WHERE expires_at < NOW();
        \`;
      `,
      errors: [{ messageId: 'outside' }],
    },
  ],
});
