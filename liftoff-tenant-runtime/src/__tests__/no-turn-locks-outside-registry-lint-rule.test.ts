// Enforcement tests for `r5/no-turn-locks-outside-registry` (INV-PB-018).
//
// The anchor cases are the real ones: the statements the five owners of
// `chat_turn_locks` each wrote for themselves, three of them deciding liveness
// from an unexpired lease against a heartbeat that ran ten times less often than
// it. They are pinned verbatim, because the property they get wrong had already
// been WRITTEN DOWN in platform-backend — twice, in the files that violated it —
// which is exactly why this is a rule and not a comment.
//
// A rule with no tests of its own can stop enforcing without anyone noticing, and
// this one's job is to stay silent for years and then fail once, when somebody
// adds a sixth reader.

import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';

const rule = require('../../eslint-rules/no-turn-locks-outside-registry.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser as never,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

const REGISTRY = 'src/interactive-chat/turn-lock-registry.ts';
const LOCKS = 'src/interactive-chat/locks.ts';
const REAPER = 'src/agent-execution/engine/workspace-reaper.ts';
const CRON = 'src/handlers/internal-cron-handler.ts';

ruleTester.run('r5/no-turn-locks-outside-registry', rule, {
  valid: [
    {
      name: 'the registry itself owns the table',
      filename: REGISTRY,
      code: `
        const r = await db(pool, client).query(
          \`SELECT acquired_by_invocation_id FROM chat_turn_locks WHERE tenant_id = $1\`, [t]);
        await db(pool, client).query(\`DELETE FROM chat_turn_locks WHERE tenant_id = $1\`, [t]);
      `,
    },
    {
      name: 'a caller that goes through the registry names no table',
      filename: LOCKS,
      code: `
        const acquisition = await acquireLock(pool, tenantId, threadId, invocationId);
        const rowCount = await heartbeatLock(pool, tenantId, threadId, invocationId);
      `,
    },
    {
      name: 'the degrade-open log EVENT names the table, and must stay allowed',
      filename: LOCKS,
      // What an operator reads when the migration has not landed yet. It is also
      // a declared log-schema key (observability/log-schemas.ts), so a rule that
      // forced it to be renamed would break the schema to enforce nothing.
      code: `
        scrubLogger.warn({ event: 'chat_turn_locks_table_missing' });
      `,
    },
    {
      name: 'a comment naming the table is not a query',
      filename: 'src/trajectories/canonical-artifact.ts',
      code: `
        // Safe because turns on one thread are serialized by \`chat_turn_locks\`.
        const x = 1;
      `,
    },
    {
      name: 'the signal table carries no liveness question',
      filename: 'src/interactive-chat/chat-turn-handler.ts',
      code: `
        await sysPool.query(
          \`INSERT INTO agent_invocation_signals (invocation_id, signal_kind, payload) VALUES ($1, $2, $3)\`,
          [id, kind, payload],
        );
      `,
    },
    {
      name: 'a sibling lock table is not this one',
      filename: CRON,
      code: `
        const r = await pool.query(
          \`DELETE FROM mirror_locks WHERE expires_at < NOW() RETURNING tenant_id, owner, repo\`);
      `,
    },
    {
      name: 'a test may assert on the SQL the registry emits',
      filename: 'src/agent-execution/engine/__tests__/chat-workspace-reaper.test.ts',
      code: `
        expect(sql).toContain('DELETE FROM chat_turn_locks');
      `,
    },
  ],

  invalid: [
    {
      // The unsafe shape: reclaim only once the LEASE has run out, which a
      // container that died satisfies twenty minutes late.
      name: "the acquire path's pre-DELETE, keyed on the lease",
      filename: LOCKS,
      code: `
        await pool.query(
          \`DELETE FROM chat_turn_locks
           WHERE tenant_id = $1 AND thread_id = $2 AND expires_at <= NOW()\`,
          [tenantId, threadId],
        );
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: "the reaper's live-workspace skip, which asked the lease",
      filename: REAPER,
      code: `
        const existing = await client.query(
          \`SELECT 1 FROM chat_turn_locks
           WHERE tenant_id = $1 AND thread_id = $2 AND expires_at > NOW()
           FOR UPDATE SKIP LOCKED\`,
          [tenantId, threadId],
        );
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: "the drain's tuple + age-fallback DELETE",
      filename: 'src/interactive-chat/sigterm-handler.ts',
      code: `
        await pool.query(
          \`DELETE FROM chat_turn_locks
           WHERE tenant_id = $1 AND thread_id = $2
             AND (acquired_by_invocation_id = $3 OR acquired_at < NOW() - INTERVAL '25 minutes')\`,
          [a, b, c],
        );
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: 'the expiry sweep',
      filename: CRON,
      code: `
        const r = await pool.query(
          \`DELETE FROM chat_turn_locks WHERE expires_at < NOW() RETURNING tenant_id, thread_id\`);
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      // The fifth owner, which is now in the registry too — so that the module's
      // exclusivity is a fact rather than a convention.
      name: "the stalled-run reconciler's release by invocation id",
      filename: 'src/scheduling/stalled-run-reconciler.ts',
      code: `
        await pool().query(
          \`DELETE FROM chat_turn_locks WHERE tenant_id = $1::uuid AND acquired_by_invocation_id = ANY($2::uuid[])\`,
          [tenantId, ids],
        );
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: 'the tombstone INSERT',
      filename: REAPER,
      code: `
        const r = await client.query(
          \`INSERT INTO chat_turn_locks (tenant_id, thread_id, acquired_by_invocation_id, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '60 seconds')
           ON CONFLICT (tenant_id, thread_id) DO NOTHING RETURNING 1\`,
          [a, b, c],
        );
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: 'the heartbeat UPDATE, wherever it is written',
      filename: 'src/interactive-chat/some-new-module.ts',
      code: `
        const SQL = \`UPDATE chat_turn_locks SET expires_at = NOW() + INTERVAL '20 minutes'\`;
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: 'a plain single-quoted string counts too',
      filename: 'src/interactive-chat/some-new-module.ts',
      code: `
        const sql = 'SELECT 1 FROM chat_turn_locks WHERE thread_id = $1';
      `,
      errors: [{ messageId: 'outside' }],
    },
    {
      name: 'a JOIN onto the lock table from a reporting query',
      filename: 'src/observability/some-report.ts',
      code: `
        const r = await pool.query(
          \`SELECT t.id FROM agent_chat_threads t JOIN chat_turn_locks l ON l.thread_id = t.id\`);
      `,
      errors: [{ messageId: 'outside' }],
    },
  ],
});
