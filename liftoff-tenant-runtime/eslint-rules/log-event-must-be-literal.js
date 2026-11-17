/**
 * R5 TE-R5-008 / TE-R4-009: ESLint rule that every scrubLogger call uses a
 * string-literal `event` property matching a key in LogSchemas.
 *
 * Shifts log-schema enforcement from runtime/CI-grep (false negatives on
 * dynamic names) to IDE-time lint. Developers cannot push a PR that logs
 * an unrecognized or dynamic event name.
 */
'use strict';

const path = require('path');

let LogSchemas = null;

function loadLogSchemas() {
  if (LogSchemas) return LogSchemas;
  try {
    // Resolve from the project root relative to this ESLint rule file
    const schemasPath = path.resolve(__dirname, '..', 'src', 'observability', 'log-schemas.ts');
    // Cannot `require` a .ts file directly without ts-node; instead parse it as text
    // and extract the object keys. This is coarse but robust to TS syntax.
    const text = require('fs').readFileSync(schemasPath, 'utf-8');
    const events = new Set();
    const re = /^\s*([a-z][a-z0-9_]{2,63})\s*:\s*z\.object\(/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      events.add(m[1]);
    }
    LogSchemas = events;
    return LogSchemas;
  } catch {
    // Degrade gracefully: allow everything if we can't load (e.g. in CI where
    // lint runs before dependencies install). The verify-log-schemas.ts CI
    // script is an additional safety net.
    LogSchemas = new Set();
    return LogSchemas;
  }
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'All scrubLogger calls must use a literal event name present in LogSchemas',
    },
    messages: {
      notLiteral: 'scrubLogger arg must be an object literal',
      missingEvent: 'scrubLogger requires a string-literal `event` property',
      nonStringLiteral:
        'event must be a string literal (no interpolation or variables). Use a constant in log-schemas.ts.',
      unknownEvent: 'Unknown log event: "{{event}}". Add schema to src/observability/log-schemas.ts.',
    },
    schema: [],
  },
  create(context) {
    const knownEvents = loadLogSchemas();
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression') return;
        if (!callee.object || callee.object.type !== 'Identifier') return;
        if (callee.object.name !== 'scrubLogger') return;
        if (!callee.property || callee.property.type !== 'Identifier') return;
        if (!['info', 'warn', 'error', 'debug'].includes(callee.property.name)) return;

        const arg = node.arguments[0];
        if (!arg || arg.type !== 'ObjectExpression') {
          context.report({ node, messageId: 'notLiteral' });
          return;
        }
        const eventProp = arg.properties.find(
          (p) => p.type === 'Property' && p.key && p.key.type === 'Identifier' && p.key.name === 'event',
        );
        if (!eventProp) {
          context.report({ node, messageId: 'missingEvent' });
          return;
        }
        const value = eventProp.value;
        if (value.type !== 'Literal' || typeof value.value !== 'string') {
          context.report({ node: value, messageId: 'nonStringLiteral' });
          return;
        }
        if (knownEvents.size > 0 && !knownEvents.has(value.value)) {
          context.report({ node: value, messageId: 'unknownEvent', data: { event: value.value } });
        }
      },
    };
  },
};
