'use strict';

/**
 * A borrowed pg client can never be allowed to kill the process.
 *
 * pg-pool attaches its own `error` listener to an IDLE client and REMOVES it the
 * moment the client is checked out (`node_modules/pg-pool/index.js:344`). From
 * that instant until it is released the client has no listener at all, and an
 * `error` event with no listener is an unhandled 'error' event: Node throws, and
 * on Cloud Run the container exits.
 *
 * Every Postgres socket on an instance can close at once while Cloud SQL is
 * healthy and no SIGTERM has been sent. If one of the ~21 borrow sites in this
 * service is holding a client, `Connection terminated unexpectedly` lands on it
 * and `Container called exit(1)` follows, taking every in-flight request and
 * every cron on that instance with it — and it can leave a turn lock behind
 * that wedges a conversation until the lock expires. Each of those 21 sites is
 * a process-kill site, and the three `.on('error')` handlers in
 * src/infrastructure/database.ts cover none of them: those fire for IDLE
 * clients only.
 *
 * `installBorrowedClientGuard` (@liftoffos/database) closes the window off the
 * pool's own `acquire` / `release` / `remove` events, which fire for
 * promise-mode `connect()`, callback-mode `connect(cb)` and `pool.query()`'s
 * internal checkout alike. NOT by wrapping `pool.connect`: `pool.query()` calls
 * `this.connect(cb)` in callback mode and gets `undefined` back, so a wrapper
 * that awaits the result and touches it throws on every `pool.query()` in the
 * service — the regression the tenant runtime records at
 * src/infrastructure/database.ts.
 *
 * A guard installed on three pools is worth nothing if the fourth pool is built
 * somewhere else, and nothing about a missing guard is visible until the day a
 * socket drops. So: the request path builds its pools in one file, and this rule
 * is what keeps that true.
 *
 * WHAT THIS FLAGS — `new Pool(...)` in a production source file that is not a
 * sanctioned constructor.
 *
 * Deliberately NOT flagged:
 *   - src/infrastructure/database.ts, which holds all three service-pool
 *     constructors and installs the guard on each.
 *   - src/scripts/**. A one-shot Cloud Run Job or operator script manages its
 *     own connection, is not on the request path, and taking it down takes
 *     nothing else with it.
 *   - Tests and src/test-utils/**. They legitimately stand up their own pools
 *     against a throwaway database.
 *
 * `packages/database/src/pool-factory.ts` is outside this config's `files` glob
 * and installs the guard itself, in `DatabasePoolFactory.getPool`.
 */
const path = require('path');

/** Files allowed to construct a request-path pool. Each installs the guard. */
const SANCTIONED = new Set(['src/infrastructure/database.ts']);

/** Not the request path: their own pool, their own blast radius. */
const EXEMPT_PATTERNS = [
  /^src\/scripts\//,
  /(^|\/)__tests__\//,
  /\.test\.ts$/,
  /^src\/test-utils\//,
];

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A request-path pg Pool is built only where the borrowed-client guard is installed (src/infrastructure/database.ts).',
    },
    messages: {
      unguarded:
        'A pg Pool built here has no borrowed-client guard. pg-pool removes its own `error` listener the moment a client is checked out, so one `Connection terminated unexpectedly` on a borrowed client is an unhandled \'error\' event and the container exits — that is how the 2026-09-29 outage started, and it takes every in-flight request and every cron on the instance with it. Build the pool in src/infrastructure/database.ts, which calls installBorrowedClientGuard on each of its three constructors. If this is a one-shot script or a test that owns its own connection, it belongs under src/scripts/, src/test-utils/ or a __tests__ directory.',
    },
    schema: [],
  },

  create(context) {
    const filename = context.getFilename ? context.getFilename() : context.filename;
    const relative = path.relative(process.cwd(), filename).replace(/\\/g, '/');

    if (SANCTIONED.has(relative)) return {};
    if (EXEMPT_PATTERNS.some((re) => re.test(relative))) return {};

    return {
      NewExpression(node) {
        const callee = node.callee;
        if (!callee) return;
        // `new Pool(...)` and `new pg.Pool(...)` are the two spellings in this
        // tree; both name the constructor `Pool`.
        const name = callee.type === 'Identifier'
          ? callee.name
          : callee.type === 'MemberExpression' && callee.property && callee.property.type === 'Identifier'
            ? callee.property.name
            : null;
        if (name !== 'Pool') return;
        context.report({ node, messageId: 'unguarded' });
      },
    };
  },
};
