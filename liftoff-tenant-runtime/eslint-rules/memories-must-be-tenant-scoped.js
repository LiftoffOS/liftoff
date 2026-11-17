'use strict';

/**
 * WS-8.3 — Layer 3 RLS audit.
 *
 * Disallow raw SQL strings that reference the `memories` table outside of a
 * `withTenantScope` block. The Layer-3 guarantee (DB-side RLS) only fires
 * when `app.tenant_id` is set on the session — pool clients that bypass
 * `withTenantScope` see the unmasked row population.
 *
 * Heuristic: scan every template literal and string literal that contains
 * the `memories` token in a SQL context (FROM/UPDATE/INSERT INTO/DELETE
 * FROM) and walk up the AST to verify the enclosing function name contains
 * `withTenantScope` (callback form) OR the file is in a list of approved
 * paths (memory/service.ts itself).
 *
 * Allowlist: any code emitting raw SQL with `memories` must either be inside
 * `withTenantScope(...)` OR carry a `// RLS_EXEMPT: <reason>` comment
 * immediately preceding the SQL string.
 */
const path = require('path');

const APPROVED_FILES = new Set([
  // Module that owns the RLS-aware query helpers + the migration scripts.
  'src/memory/service.ts',
  'src/memory/deep-scan-worker.ts',
  // Memory router unwraps via memoryService.getMemory which is itself RLS-aware.
  'src/memory/router.ts',
]);

const SQL_AGAINST_MEMORIES_RE = /(?:FROM|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+memories\b/i;

function findEnclosingFunctionName(node) {
  let cursor = node.parent;
  while (cursor) {
    if (cursor.type === 'CallExpression') {
      const callee = cursor.callee;
      if (callee && callee.type === 'Identifier' && callee.name === 'withTenantScope') return 'withTenantScope';
      if (
        callee &&
        callee.type === 'MemberExpression' &&
        callee.property &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'withTenantScope'
      ) {
        return 'withTenantScope';
      }
    }
    cursor = cursor.parent;
  }
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow raw SQL against the memories table outside withTenantScope (WS-8.3 Layer 3 RLS audit).',
    },
    messages: {
      unscoped:
        'Raw SQL against the `memories` table must run inside `withTenantScope(...)` so RLS applies. Wrap the query, or — if intentional — add a // RLS_EXEMPT: <reason> comment immediately above the string.',
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
    const filename = context.getFilename ? context.getFilename() : context.filename;
    const relative = path.relative(process.cwd(), filename).replace(/\\/g, '/');
    // Approved files: don't lint at all.
    for (const allowed of APPROVED_FILES) {
      if (relative.endsWith(allowed)) return {};
    }

    function check(node, raw) {
      if (typeof raw !== 'string') return;
      if (!SQL_AGAINST_MEMORIES_RE.test(raw)) return;
      // Allow if a preceding comment carries an RLS_EXEMPT marker.
      const before = sourceCode.getCommentsBefore(node);
      if (before.some((c) => /RLS_EXEMPT/.test(c.value))) return;
      // Allow if surrounded by withTenantScope(...).
      if (findEnclosingFunctionName(node) === 'withTenantScope') return;
      context.report({ node, messageId: 'unscoped' });
    }

    return {
      TemplateLiteral(node) {
        const raw = node.quasis.map((q) => q.value && q.value.raw).join(' ');
        check(node, raw);
      },
      Literal(node) {
        if (typeof node.value !== 'string') return;
        check(node, node.value);
      },
    };
  },
};
