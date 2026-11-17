'use strict';

/**
 * INV-PB-018 — one module owns every turn-lock table.
 *
 * `liftoff_turn_locks` and `insights_turn_locks` answer exactly one question:
 * is a turn running on this thread right now. Three readers and one acquire
 * path each answered it themselves, with the same wrong predicate
 * (`expires_at > NOW()`), against a heartbeat that ran ten times less often
 * than the lease it wrote into. Two of them carried a comment asserting the
 * opposite of what their own SQL did.
 *
 * If an instance loses every Postgres socket at once and exits, the lock row
 * for the turn in flight stays, and until the lease runs out every message to
 * that thread is accepted at once and filed as an interrupt addressed to a
 * turn nothing is running: no reply, and a toast blaming the connection.
 * Writing the property down again is not a fix — two comments already stated
 * it.
 *
 * So: `src/common/turn-registry.ts` is the only place either table may be named
 * in SQL, and this rule is what keeps that true. A fourth reader cannot
 * reinvent the predicate, and "idle" and "acquirable" cannot drift apart,
 * because they are one string.
 *
 * WHAT THIS FLAGS — a string or template literal whose text references either
 * table through a SQL table-reference keyword (`FROM` / `JOIN` / `INTO` /
 * `UPDATE` / `DELETE FROM`), anywhere outside the registry. Matching the
 * keyword rather than the bare name is deliberate, and mirrors
 * no-raw-pool-on-rls-table.js's `TABLE_REF`: it catches the SQL wherever it is
 * written — a `.query()` argument, a const assembled elsewhere, a helper — and
 * leaves prose alone. Both surfaces log `'<table> missing: running the turn
 * without mid-run control'` when their migration has not landed yet, which
 * names the table for an operator and queries nothing.
 *
 * Deliberately NOT flagged:
 *   - The registry itself.
 *   - Tests. A test asserting on the SQL the registry emits is the point of
 *     having one place that emits it.
 *   - The signal tables (`*_turn_signals`). They are addressed by turn_id and
 *     carry no liveness question, so nothing about them can disagree.
 *
 * There is no escape hatch. A caller that needs its own transaction passes its
 * client — every registry function takes one — which is what the tenant
 * runtime's workspace reaper and this service's presence poll both do.
 */
const path = require('path');

const LOCK_TABLES = new Set(['liftoff_turn_locks', 'insights_turn_locks']);

/** The registry, and nothing else, may name these tables in SQL. */
const REGISTRY_FILE = 'src/common/turn-registry.ts';

/** FROM / JOIN / INTO / UPDATE / DELETE FROM <table>. Same shape as
 *  no-raw-pool-on-rls-table.js, so the two rules agree on what "naming a table
 *  in SQL" means. */
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
        'The turn-lock tables may only be named in SQL by src/common/turn-registry.ts (INV-PB-018).',
    },
    messages: {
      outside:
        'This SQL names {{tables}}, which only src/common/turn-registry.ts may query (INV-PB-018). A lock is not a heartbeat: liveness is read from `heartbeat_at` inside one window, never inferred from an unexpired lease, and the three readers that each wrote `expires_at > NOW()` themselves are why this rule exists — one of them under a comment asserting the opposite. Call the registry instead: findActiveTurnId / liveTurnId / acquireLock / heartbeatLock / releaseLock, each of which takes an optional client so a caller already inside a transaction keeps its atomicity.',
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
