/**
 * R5 TE-R5-003: ESLint rule that createIsolatedPath() return must be assigned.
 *
 * Prevents the anti-pattern of calling createIsolatedPath(name) twice and
 * getting two different UUIDs (since it calls crypto.randomUUID each time).
 * Callers must assign to a variable and reuse.
 */
'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'createIsolatedPath() must have its return value assigned to a variable',
    },
    messages: {
      mustAssign: 'createIsolatedPath() return value must be assigned (it generates a new UUID each call)',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'Identifier' || callee.name !== 'createIsolatedPath') return;

        // Walk up to the immediate parent statement.
        // Valid: const x = createIsolatedPath(...)  (VariableDeclarator)
        // Valid: x = createIsolatedPath(...)        (AssignmentExpression)
        // Valid: foo(createIsolatedPath(...))       (argument)
        // Valid: return createIsolatedPath(...)     (ReturnStatement)
        // Invalid: createIsolatedPath(...)          (bare ExpressionStatement)
        const parent = node.parent;
        if (!parent) return;
        if (parent.type === 'ExpressionStatement') {
          context.report({ node, messageId: 'mustAssign' });
        }
      },
    };
  },
};
