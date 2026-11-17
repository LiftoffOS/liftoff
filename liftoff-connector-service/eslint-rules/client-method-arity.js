'use strict';

/**
 * A CompensationClient implementation must declare the interface's parameters.
 *
 * THE DEFECT THIS EXISTS FOR. `CompensationClient.read` is declared
 * `(entityType, entityId, payload?)` in types.ts, and BOTH executors in
 * adapter.ts call it with three arguments. `GenericMCPClient.read` declared
 * two. Passing an extra argument to a shorter function is legal JavaScript and
 * satisfies TypeScript's structural check — a function with FEWER parameters is
 * assignable to a signature with more — so the payload was discarded in
 * silence: no error, no log, no type complaint.
 *
 * Every read-verb tool on a generic-MCP connector therefore reached its vendor
 * with `{ id }` or `{}`. GitHub answered "missing required parameter: owner"
 * while the action ledger showed all four arguments present, and the failure
 * never named its own cause: `inferCrudOp` routes by NAME, so `create` and
 * `update` forwarded correctly and only the read verbs broke — which presents
 * as a permissions problem.
 *
 * TypeScript cannot flag this; that is the language rule, not a config choice.
 * So it is a lint rule.
 *
 * A RATCHET, NOT A SWEEP. Roughly thirty implementations declare fewer
 * parameters than their interface, and most are harmless: an id-addressed
 * client like stripe-mcp maps an entity type to a specific tool and validates
 * the id first, so `{ id }` is correct there BY DESIGN. Bulk-editing them would
 * be a large change nobody can validate. The existing set is frozen as debt and
 * anything new fails, exactly as this estate freezes orphan exports and
 * unguarded routes.
 */

/** Interface arity, from src/clients/types.ts. A method not listed is not
 *  checked — the rule refuses to guess at a contract it was not told. */
const REQUIRED_ARITY = {
  read: 3,    // (entityType, entityId, payload?)
  delete: 3,  // (entityType, entityId, payload?)
  update: 3,  // (entityType, entityId, data)
  create: 2,  // (entityType, data)
  list: 2,    // (entityType, filters?)
};

/** Frozen debt: `<file basename>#<method>` already below the interface arity.
 *  Removing an entry is the goal. Adding one is a decision, not a formality. */
const BASELINE = new Set(require('./client-arity-baseline.json'));

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A CompensationClient method must declare the interface\'s parameters; a shorter '
        + 'implementation silently discards the arguments its caller passes.',
    },
    messages: {
      tooFewParams:
        '{{cls}}.{{method}} declares {{actual}} parameter(s); CompensationClient.{{method}} '
        + 'declares {{required}}, and adapter.ts calls it with all of them. JavaScript drops '
        + 'the extra silently and TypeScript cannot flag it — which is how every read-verb '
        + 'tool on a generic-MCP connector reached its vendor with no arguments. Declare the '
        + 'full signature and use it, or add "{{key}}" to eslint-rules/client-arity-baseline.json '
        + 'with a reason in the pull request if this client is genuinely id-addressed.',
    },
    schema: [],
  },

  create(context) {
    const filename = context.getFilename();
    if (!/[\\/]src[\\/]clients[\\/]/.test(filename)) return {};
    if (/\.test\.ts$/.test(filename)) return {};
    const base = filename.split(/[\\/]/).pop();

    return {
      MethodDefinition(node) {
        if (node.kind !== 'method' || node.computed) return;
        const method = node.key && node.key.name;
        const required = REQUIRED_ARITY[method];
        if (!required) return;

        // Only classes that actually implement the client contract. A helper
        // class with a `read` of its own is not making this promise.
        const cls = node.parent && node.parent.parent;
        if (!cls || cls.type !== 'ClassDeclaration') return;
        const implementsClient = (cls.implements || []).some(
          (i) => i.expression && /Client$/.test(i.expression.name || ''),
        );
        if (!implementsClient) return;

        const actual = node.value.params.length;
        if (actual >= required) return;

        const key = `${base}#${method}`;
        if (BASELINE.has(key)) return;

        context.report({
          node: node.key,
          messageId: 'tooFewParams',
          data: {
            cls: cls.id ? cls.id.name : 'class',
            method,
            actual: String(actual),
            required: String(required),
            key,
          },
        });
      },
    };
  },
};
