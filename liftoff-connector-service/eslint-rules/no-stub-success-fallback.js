'use strict';

/**
 * Disallow:
 *   (a) Standard-tool stub responses — fabricated success strings of the
 *       form `Standard tool ${name} executed`.
 *   (b) Hardcoded placeholder.<vendor>.* MCP URLs that have no urlResolver
 *       sibling property and no `// PER_WORKSPACE_TEMPLATE: <reason>`
 *       marker comment.
 *   (c) Return statements whose surrounding comment block contains
 *       "stub" / "placeholder" / "fake" without a
 *       `// LEGITIMATE_NO_OP: <reason>` marker.
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Standard-tool stub responses and placeholder MCP URLs without per-workspace markers',
    },
    messages: {
      stubSuccess:
        'Stub-shaped success response detected. A tool that cannot dispatch must return {success:false, error}, never a fabricated success.',
      placeholderUrl:
        'Hardcoded placeholder.<vendor>.* URL without urlResolver or // PER_WORKSPACE_TEMPLATE marker.',
      stubComment:
        'Function returns a value whose surrounding comment marks it as a stub/placeholder/fake without a // LEGITIMATE_NO_OP: <reason> marker.',
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.getSourceCode
      ? context.getSourceCode()
      : context.sourceCode;

    return {
      // (a) `Standard tool ${X} executed` template literal
      TemplateLiteral(node) {
        const headRaw = node.quasis[0] && node.quasis[0].value && node.quasis[0].value.raw;
        const tailRaw =
          node.quasis[node.quasis.length - 1] &&
          node.quasis[node.quasis.length - 1].value &&
          node.quasis[node.quasis.length - 1].value.raw;
        if (
          typeof headRaw === 'string' &&
          typeof tailRaw === 'string' &&
          headRaw.startsWith('Standard tool ') &&
          tailRaw.endsWith(' executed')
        ) {
          context.report({ node, messageId: 'stubSuccess' });
        }
      },

      // (b) https://placeholder.<vendor>.* string literal without
      // sibling urlResolver or // PER_WORKSPACE_TEMPLATE marker
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (!/^https:\/\/placeholder\./i.test(node.value)) return;

        // Walk up to enclosing object literal
        let cursor = node.parent;
        let enclosingObject = null;
        while (cursor) {
          if (cursor.type === 'ObjectExpression') {
            enclosingObject = cursor;
            break;
          }
          cursor = cursor.parent;
        }
        if (enclosingObject) {
          const hasResolver = enclosingObject.properties.some(
            (p) =>
              p.type === 'Property' &&
              p.key &&
              p.key.type === 'Identifier' &&
              p.key.name === 'urlResolver',
          );
          if (hasResolver) return;
        }

        // Look for the marker anywhere reasonable: on the literal itself,
        // before/inside the enclosing Property (where humans naturally put
        // the comment), or anywhere inside the enclosing ObjectExpression.
        const beforeLiteral = sourceCode.getCommentsBefore(node);
        if (beforeLiteral.some((c) => /PER_WORKSPACE_TEMPLATE/.test(c.value))) return;
        let walker = node.parent;
        while (walker) {
          if (walker.type === 'Property' || walker.type === 'ObjectExpression') {
            const cmts = sourceCode.getCommentsBefore(walker).concat(sourceCode.getCommentsInside(walker));
            if (cmts.some((c) => /PER_WORKSPACE_TEMPLATE/.test(c.value))) return;
          }
          if (walker.type === 'ObjectExpression') break;
          walker = walker.parent;
        }

        context.report({ node, messageId: 'placeholderUrl' });
      },

      // (c) return statement returning an object literal containing
      // `success: true` whose preceding comments mention stub/placeholder/fake.
      // Only the (success: true + stub-comment) intersection is the real
      // bug pattern; bare comments mentioning those words in unrelated
      // contexts are noise.
      ReturnStatement(node) {
        const before = sourceCode.getCommentsBefore(node);
        if (!before.length) return;
        const allText = before.map((c) => c.value).join(' ');
        if (!/\b(stub|placeholder|fake)\b/i.test(allText)) return;
        if (/LEGITIMATE_NO_OP/.test(allText)) return;
        // Require the returned value to be an object literal with success:true.
        const arg = node.argument;
        if (!arg || arg.type !== 'ObjectExpression') return;
        const hasSuccessTrue = arg.properties.some(
          (p) =>
            p.type === 'Property' &&
            p.key &&
            ((p.key.type === 'Identifier' && p.key.name === 'success') ||
              (p.key.type === 'Literal' && p.key.value === 'success')) &&
            p.value &&
            p.value.type === 'Literal' &&
            p.value.value === true,
        );
        if (hasSuccessTrue) {
          context.report({ node, messageId: 'stubComment' });
        }
      },
    };
  },
};
