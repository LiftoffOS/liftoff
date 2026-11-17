/**
 * INV-TR-016 — a managed secret is read from the store, never from `process.env`.
 *
 * `loadSecretsToEnv` hydrates into a module-private Map
 * (`infrastructure/secret-store.ts`) and writes `process.env` only for the
 * entries something outside this repo reads from there. So in production the
 * environment does NOT hold these values, and `process.env.OPENAI_API_KEY`
 * evaluates to undefined.
 *
 * This rule exists because that failure is invisible locally. `getManagedSecret`
 * falls back to `process.env` so a developer's exported variable and a test's
 * `setup.ts` keep working — which means an unmigrated read passes every local
 * check and returns undefined only in Cloud Run. Lint is what closes that gap,
 * not the fallback.
 *
 * WRITES are allowed. Test setup assigns, and `loadSecretsToEnv` assigns for the
 * env-bound entries; both are how a value gets there in the first place.
 */
'use strict';

// Kept in sync with MANAGED_SECRET_NAMES in src/infrastructure/secret-store.ts.
// A test asserts the two lists match, because a rule that silently stops
// covering a secret is worse than no rule.
const MANAGED_SECRETS = new Set([
  'DB_PASSWORD',
  'TENANT_RUNTIME_SERVICE_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'OPENAI_API_KEY',
  'OPENAI_API_KEY_AGENT_EXECUTION',
  'OPENAI_API_KEY_BACKGROUND_SERVICES',
  'OPENAI_API_KEY_PLATFORM_ANALYTICS',
  'OPENAI_API_KEY_REFLECTIVE_SERVICES',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AGENT_SLACK_SERVICE_TOKEN',
  'AGENT_TEAMS_SERVICE_TOKEN',
  'COMPOSIO_API_KEY',
  'PLATFORM_CALLBACK_TOKEN',
  'CONNECTOR_SERVICE_TOKEN',
  'GOVERNANCE_SERVICE_TOKEN',
]);

/** The two files that own the mechanism, plus test setup. */
const EXEMPT_SUFFIXES = [
  '/src/infrastructure/secret-store.ts',
  '/src/infrastructure/secrets.ts',
  '/src/test-utils/setup.ts',
];

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Read managed secrets through getManagedSecret(), not process.env',
    },
    messages: {
      useStore:
        "process.env.{{name}} is undefined in production: loadSecretsToEnv() hydrates the "
        + "secret store, not the environment. Use getManagedSecret('{{name}}') from "
        + 'infrastructure/secret-store. See INV-TR-016.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename !== undefined ? context.filename : context.getFilename();
    if (!filename.includes('/src/')) return {};
    if (EXEMPT_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return {};
    // Tests may set and read the environment freely; they are not production
    // readers and the store falls back to env for exactly that reason.
    if (filename.includes('/__tests__/') || /\.(test|spec)\.ts$/.test(filename)) return {};

    /** `process.env.NAME` — the member expression for the secret itself. */
    function secretNameOf(node) {
      if (!node || node.type !== 'MemberExpression') return null;
      const inner = node.object;
      if (
        !inner
        || inner.type !== 'MemberExpression'
        || inner.object.type !== 'Identifier'
        || inner.object.name !== 'process'
        || inner.property.type !== 'Identifier'
        || inner.property.name !== 'env'
      ) {
        return null;
      }
      // process.env.NAME and process.env['NAME'] both count.
      let name = null;
      if (!node.computed && node.property.type === 'Identifier') name = node.property.name;
      else if (node.computed && node.property.type === 'Literal') name = node.property.value;
      return typeof name === 'string' && MANAGED_SECRETS.has(name) ? name : null;
    }

    return {
      MemberExpression(node) {
        const name = secretNameOf(node);
        if (name === null) return;
        // An assignment target is how the value gets there; only reads are the
        // problem.
        const parent = node.parent;
        if (parent && parent.type === 'AssignmentExpression' && parent.left === node) return;
        if (parent && parent.type === 'UnaryExpression' && parent.operator === 'delete') return;
        context.report({ node, messageId: 'useStore', data: { name } });
      },
    };
  },
};
