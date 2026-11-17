'use strict';

/**
 * INV-PB-018 — one module owns the turn-lock table.
 *
 * `chat_turn_locks` answers exactly one question: is a turn running on this
 * thread right now. Three owners each answered it themselves, from an unexpired
 * lease, against a heartbeat that ran ten times less often than the lease it
 * wrote into — `locks.ts`'s acquire, the workspace reaper's live-workspace skip,
 * and the SIGTERM drain.
 *
 * The hazard: an instance that loses every Postgres socket at once and exits
 * leaves the lock row for the turn in flight, and until the lease runs out every
 * message to that thread is accepted at once and filed as an interrupt addressed
 * to a turn nothing is running — no reply, and a toast blaming the connection.
 * platform-backend's turn-lock tables have the same shape, the same two
 * constants and the same readers, so team chat carries the same risk. There the
 * property had been WRITTEN DOWN, twice, in the files that violated it — which
 * is why this is a rule and not a comment.
 *
 * So: `src/interactive-chat/turn-lock-registry.ts` is the only place the table
 * may be named in SQL, and this rule is what keeps that true. A fourth reader
 * cannot reinvent the predicate, and "idle" and "acquirable" cannot drift apart,
 * because they are one string.
 *
 * WHAT THIS FLAGS — a string or template literal whose text references the table
 * through a SQL table-reference keyword (`FROM` / `JOIN` / `INTO` / `UPDATE` /
 * `DELETE FROM`), anywhere outside the registry. Matching the keyword rather than
 * the bare name is deliberate, and mirrors platform-backend's sibling rule: it
 * catches the SQL wherever it is written — a `.query()` argument, a const
 * assembled elsewhere, a helper — and leaves prose alone. `locks.ts` logs
 * `{ event: 'chat_turn_locks_table_missing' }` when the migration has not landed
 * yet, and `log-schemas.ts` declares that event name; both name the table for an
 * operator and query nothing.
 *
 * Deliberately NOT flagged:
 *   - The registry itself.
 *   - Tests. A test asserting on the SQL the registry emits is the point of
 *     having one place that emits it.
 *   - `agent_invocation_signals`. A signal is addressed by invocation id and
 *     carries no liveness question, so nothing about it can disagree.
 *
 * There is no escape hatch. A caller that needs its own transaction passes its
 * client — every registry function takes one — which is what the workspace
 * reaper's `BEGIN … FOR UPDATE SKIP LOCKED` does.
 */
const path = require('path');

const LOCK_TABLES = new Set(['chat_turn_locks']);

/** The registry, and nothing else, may name these tables in SQL. */
const REGISTRY_FILE = 'src/interactive-chat/turn-lock-registry.ts';

/** FROM / JOIN / INTO / UPDATE / DELETE FROM <table>. Same shape as
 *  platform-backend's rule, so both repos agree on what "naming a table in SQL"
 *  means. */
const TABLE_REF =
  /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_][a-z0-9_]*)"?/gi;

function referencedLockTables(text) {
  const found = new Set();
  TABLE_REF.lastIndex = 0;
  let m;
  while ((m = TABLE_REF.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (LOCK_TABLES.has(name)) found.add(name);
  }
  return [...found];
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'chat_turn_locks may only be named in SQL by src/interactive-chat/turn-lock-registry.ts (INV-PB-018).',
    },
    messages: {
      outside:
        'This SQL names {{tables}}, which only src/interactive-chat/turn-lock-registry.ts may query (INV-PB-018). A lock is not a heartbeat: liveness is read from `heartbeat_at` inside one window, never inferred from an unexpired lease, and the three owners that each wrote `expires_at > NOW()` themselves are why this rule exists. Call the registry instead — liveLockInvocationId / lockIsLiveForUpdate / acquireLock / heartbeatLock / releaseLock / releaseLockOnDrain / acquireTombstone / deleteDeadLock / releaseLocksForInvocations / sweepExpiredLocks — each of which takes a client so a caller already inside a transaction keeps its atomicity.',
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
    const filename = context.getFilename ? context.getFilename() : context.filename;
    const relative = path.relative(process.cwd(), filename).replace(/\\/g, '/');

    if (relative === REGISTRY_FILE) return {};
    if (/(^|\/)__tests__\//.test(relative) || /\.test\.ts$/.test(relative)) return {};

    const report = (node) => {
      const hits = referencedLockTables(sourceCode.getText(node));
      if (hits.length === 0) return;
      context.report({
        node,
        messageId: 'outside',
        data: { tables: hits.map((t) => `\`${t}\``).join(', ') },
      });
    };

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        report(node);
      },
      TemplateLiteral(node) {
        report(node);
      },
    };
  },
};
