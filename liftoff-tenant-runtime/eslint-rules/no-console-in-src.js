/**
 * R5 SE-R5-010 (defense-in-depth): prevent direct `console.log/warn/error` in src/.
 *
 * All user-facing log output must go through scrubLogger so secrets are
 * scrubbed. `console.*` writes still go through our wrapped stdout/stderr
 * (installProcessScrubbers), but having a single canonical logging path makes
 * audit + schema enforcement trivial.
 */
'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Use scrubLogger instead of console.* in src/',
    },
    messages: {
      noConsole: 'Direct console.{{method}} is forbidden in src/. Use scrubLogger.',
    },
    schema: [],
  },
  create(context) {
    // ESLint 10 flat config: context.filename; fall back to getFilename for older.
    const filename = (context.filename !== undefined ? context.filename : context.getFilename());
    // Only applies to src/; eslint-rules themselves and tests may use console.
    if (!filename.includes('/src/')) return {};
    return {
      MemberExpression(node) {
        if (
          node.object &&
          node.object.type === 'Identifier' &&
          node.object.name === 'console' &&
          node.property &&
          node.property.type === 'Identifier' &&
          ['log', 'warn', 'error', 'info', 'debug'].includes(node.property.name)
        ) {
          context.report({ node, messageId: 'noConsole', data: { method: node.property.name } });
        }
      },
    };
  },
};
