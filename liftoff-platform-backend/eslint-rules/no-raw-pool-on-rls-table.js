'use strict';

/**
 * INV-PB-001 — every query against an RLS table runs under a scope.
 *
 * ~103 tables are `FORCE ROW LEVEL SECURITY` and their policy reads
 * `tenant_id = current_setting('app.current_tenant_id')::uuid` with no
 * missing_ok. Off a scoped connection that call raises 42704,
 * "unrecognized configuration parameter", and the statement dies. There is no
 * partial failure and no empty result to notice in testing: the query throws,
 * every time, for every caller.
 *
 * For example, a query like `findProfilesByIds` joining `tenant_members` on
 * `getPool().query()` looks fine because `accounts` is on migration 200's
 * platform-global exclusion list, but `tenant_members` is not, so the endpoint
 * 500s on every call. A router test that mocks the repository wholesale will
 * not catch it, which is why this is a lint rule. INV-PB-001's drift check was "grep src/ by hand" — this replaces that.
 *
 * WHAT THIS FLAGS — a query issued on an unscoped pool (`getPool().query(...)`,
 * `pool.query(...)`, `this.pool.query(...)`) whose SQL names a table in
 * eslint-rules/rls-tables.json, which is generated from the live database.
 *
 * That list includes partitioned PARENTS (`pg_class.relkind='p'`), which the
 * first version of it missed by filtering to `relkind='r'`. They are the names
 * code writes — `cost_attribution_events`, `tenant_resource_usage` — since
 * nothing queries a partition child directly, and Postgres applies the child's
 * policy to a read of the parent, so an unscoped read throws exactly the same.
 *
 * Deliberately NOT flagged:
 *   - `client.query` / `db.query` inside a withTenantScope / withAdminScope
 *     callback. Those receive an already-scoped client, which is the fix, and
 *     the callback parameter is conventionally named `client` or `db`.
 *   - SQL that names only platform-global tables (accounts, plans, tenants, …).
 *     Those are excluded from RLS on purpose — see INV-PB-005.
 *   - Test files.
 *
 * Escape hatch: `// RLS_RAW_POOL_OK: <reason>` on or immediately above the
 * call. The one legitimate case today is a standalone one-time backfill script
 * that manages its own Pool and is documented to run as a BYPASSRLS role.
 *
 * Adding a tenant table? Run `npm run rls:tables` against a migrated database
 * to regenerate the list. scripts/__tests__/rls-table-list-ratchet.test.ts
 * fails the build if a migration introduces a tenant_id table the list has
 * never heard of, so the list cannot silently rot.
 */
const path = require('path');
const { tables } = require('./rls-tables.json');

const RLS_TABLES = new Set(tables);

/**
 * Pool expressions that carry NO tenant context. `client` and `db` are absent
 * on purpose: those are the conventional names for the scoped client handed to
 * a withTenantScope / withAdminScope callback, and flagging them would flag the
 * fix itself.
 */
const UNSCOPED_POOL = /^(getPool\(\)|pool|this\.pool|this\.db|_pool)$/;

/** FROM / JOIN / INTO / UPDATE / DELETE FROM <table>. */
const TABLE_REF =
  /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_][a-z0-9_]*)"?/gi;

function referencedRlsTables(sqlText) {
  const found = new Set();
  TABLE_REF.lastIndex = 0;
  let m;
  while ((m = TABLE_REF.exec(sqlText)) !== null) {
    const name = m[1].toLowerCase();
    if (RLS_TABLES.has(name)) found.add(name);
  }
  return [...found];
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Queries against RLS-enabled tables must run under withTenantScope or withAdminScope, never a raw pool (INV-PB-001).',
    },
    messages: {
      unscoped:
        'This query runs on an unscoped pool but reads {{tables}}, which {{verb}} FORCE ROW LEVEL SECURITY. The policy calls current_setting(\'app.current_tenant_id\') with no value set, so this throws 42704 at runtime for every caller — it cannot work in any environment (INV-PB-001). Wrap it in withTenantScope(tenantId, (client) => client.query(...)), or withAdminScope({caller, reason}, ...) if it is genuinely cross-tenant. If this file manages its own BYPASSRLS connection, add // RLS_RAW_POOL_OK: <reason>.',
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
    const filename = context.getFilename ? context.getFilename() : context.filename;
    const relative = path.relative(process.cwd(), filename).replace(/\\/g, '/');

    if (/(^|\/)__tests__\//.test(relative) || /\.test\.ts$/.test(relative)) return {};
    // The scope wrappers themselves legitimately touch the raw pool.
    if (/^src\/infrastructure\/database\.ts$/.test(relative)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          !callee ||
          callee.type !== 'MemberExpression' ||
          !callee.property ||
          callee.property.name !== 'query'
        ) {
          return;
        }

        const receiver = sourceCode.getText(callee.object);
        if (!UNSCOPED_POOL.test(receiver)) return;

        const firstArg = node.arguments[0];
        if (!firstArg) return;
        const sqlText = sourceCode.getText(firstArg);

        const hits = referencedRlsTables(sqlText);
        if (hits.length === 0) return;

        // Escape hatch, on the statement or immediately above it.
        const statement = (function enclosingStatement(n) {
          let cur = n;
          while (cur.parent && !/Statement|Declaration/.test(cur.parent.type)) cur = cur.parent;
          return cur.parent || n;
        })(node);
        const comments = [
          ...sourceCode.getCommentsBefore(statement),
          ...sourceCode.getCommentsBefore(node),
          ...sourceCode.getCommentsInside(node),
        ];
        if (comments.some((c) => /RLS_RAW_POOL_OK/.test(c.value))) return;

        context.report({
          node,
          messageId: 'unscoped',
          data: {
            tables: hits.map((t) => `\`${t}\``).join(', '),
            verb: hits.length === 1 ? 'carries' : 'carry',
          },
        });
      },
    };
  },
};
